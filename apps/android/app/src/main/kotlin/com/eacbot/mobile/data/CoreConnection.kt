package com.eacbot.mobile.data

import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.CoreUrl
import com.eacbot.mobile.core.LiveEventsListener
import com.eacbot.mobile.core.LiveNotification
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.core.NotificationDecision
import com.eacbot.mobile.core.NotificationPolicy
import com.eacbot.mobile.core.SseConnectionState
import com.eacbot.mobile.core.SseLiveEvents
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl

/** Which surface the app is showing. The shell decides from this alone. */
sealed interface SessionPhase {
    /** No core is paired. */
    data object NeedsPairing : SessionPhase

    /** A core is paired and the live stream is being opened. */
    data class Connecting(val core: PairedCore) : SessionPhase

    /** The core answered; `streamConnected` says whether live hints are flowing. */
    data class Live(val core: PairedCore, val streamConnected: Boolean) : SessionPhase

    /** The bearer is gone. The credential has already been cleared. */
    data class SignedOut(val reason: String) : SessionPhase
}

/**
 * The app's single connection to the core.
 *
 * It owns the credential's lifetime: a 401 from any request or from the stream
 * clears the stored bearer and moves the app to [SessionPhase.NeedsPairing], so
 * no screen decides that for itself. It also owns the live stream and the last
 * cursor, so a reconnect replays from the right place instead of starting at
 * "now".
 */
class CoreConnection(
    private val sessions: SessionStore,
    private val onNotification: (NotificationDecision) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val phaseState = MutableStateFlow<SessionPhase>(SessionPhase.NeedsPairing)
    val phase: StateFlow<SessionPhase> = phaseState.asStateFlow()

    private val missionState = MutableStateFlow<Map<String, Mission>>(emptyMap())
    val missions: StateFlow<Map<String, Mission>> = missionState.asStateFlow()

    private val streamState = MutableStateFlow(SseConnectionState(false, 0, 0, null))
    val stream: StateFlow<SseConnectionState> = streamState.asStateFlow()

    private val errors = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val failures: SharedFlow<String> = errors.asSharedFlow()

    /** Every notification the stream delivered, for a screen that needs to
     * refetch its own slice. It carries no task state: the screen reads that
     * over REST. */
    private val hints = MutableSharedFlow<LiveNotification>(extraBufferCapacity = 32)
    val notifications: SharedFlow<LiveNotification> = hints.asSharedFlow()

    private var api: CoreApi? = null
    private var live: SseLiveEvents? = null
    private var paired: PairedCore? = null
    private val recentNotifications = mutableMapOf<String, Long>()
    private var foreground = false

    fun currentApi(): CoreApi? = api

    fun currentCore(): PairedCore? = paired

    /** Reads the stored credential and opens the stream. Called once at start
     * and again after a pairing. */
    fun restore() {
        val stored = sessions.load()
        if (stored == null) {
            phaseState.value = SessionPhase.NeedsPairing
            return
        }
        connect(stored)
    }

    /** Pairs with a code the local terminal printed, then stores the bearer.
     * The token never reaches a log, a screenshot or a saved view. */
    fun pair(baseUrlText: String, code: String, label: String): Result<PairedCore> {
        val base = CoreUrl.normalize(baseUrlText)
            ?: return Result.failure(IllegalArgumentException("That address is not a URL"))
        val probe = CoreApi(base, { null }, {})
        return runCatching { probe.claimPairing(code, label) }.mapCatching { pairing ->
            val core = PairedCore(
                baseUrl = base.toString(),
                label = label,
                sessionId = pairing.sessionId,
                scope = pairing.scope,
                expiresAt = pairing.expiresAt,
            )
            sessions.save(core, pairing.token)
            connect(core)
            core
        }
    }

    /** Forgets this phone. It revokes the session on the core when it can, then
     * clears the credential whatever the answer was. */
    fun forgetDevice() {
        val current = api
        val sessionId = sessions.sessionId()
        if (current != null && sessionId != null) {
            runCatching { current.revokeSession(sessionId) }
        }
        disconnect()
        sessions.clear()
        paired = null
        api = null
        missionState.value = emptyMap()
        phaseState.value = SessionPhase.NeedsPairing
    }

    /** The core refused the bearer. Clearing it is the only correct answer. */
    fun signedOut(reason: String = "This phone is no longer signed in") {
        disconnect()
        sessions.clear()
        paired = null
        api = null
        missionState.value = emptyMap()
        phaseState.value = SessionPhase.SignedOut(reason)
    }

    fun setForeground(value: Boolean) {
        foreground = value
    }

    /** Adopts a snapshot the caller just read, so a stream hint is folded
     * against what is actually on screen. */
    fun adoptMissions(list: List<Mission>) {
        val previous = missionState.value
        missionState.value = list.associateBy { it.id }
        for (mission in list) {
            val before = previous[mission.id]?.status
            val decision = NotificationPolicy.decide(
                missionId = mission.id,
                missionTitle = mission.title,
                previous = before,
                current = mission.status,
                runId = mission.activeRunId,
                appInForeground = foreground,
                recentlyNotified = throttledKeys(),
            ) ?: continue
            recentNotifications["${mission.id}:${decision.kind}"] = now()
            onNotification(decision)
        }
    }

    private fun throttledKeys(): Set<String> {
        val cutoff = now() - NOTIFICATION_THROTTLE_MS
        recentNotifications.entries.removeAll { it.value < cutoff }
        return recentNotifications.keys.toSet()
    }

    private fun connect(core: PairedCore) {
        disconnect()
        paired = core
        val base = CoreUrl.normalize(core.baseUrl)
        if (base == null) {
            signedOut("The saved address is not a URL")
            return
        }
        phaseState.value = SessionPhase.Connecting(core)
        val client = CoreApi(
            baseUrl = base,
            tokens = sessions,
            onUnauthorized = { signedOut() },
        )
        api = client
        val connection = SseLiveEvents(
            api = client,
            listener = object : LiveEventsListener {
                override fun onNotification(notification: LiveNotification) {
                    handleNotification(notification)
                }

                override fun onResync(reason: String?) {
                    if (reason == "unauthenticated") {
                        signedOut()
                        return
                    }
                    // The cursor was too old to replay, so the snapshot on
                    // screen may be missing entries: refetch rather than trust
                    // the stream as contiguous.
                    refreshMissions()
                }

                override fun onState(state: SseConnectionState) {
                    streamState.value = state
                    state.lastCursor?.let { sessions.saveCursor(it) }
                    val current = phaseState.value
                    if (current is SessionPhase.Connecting || current is SessionPhase.Live) {
                        phaseState.value = SessionPhase.Live(core, state.connected)
                    }
                }
            },
        )
        live = connection
        core.lastCursor?.let { connection.seedCursor(it) }
        connection.start()
        phaseState.value = SessionPhase.Live(core, false)
        refreshMissions()
    }

    private fun handleNotification(notification: LiveNotification) {
        streamState.value = streamState.value.copy(lastCursor = notification.cursor)
        sessions.saveCursor(notification.cursor)
        hints.tryEmit(notification)
        if (notification.isShutdown) return
        refreshMissions()
    }

    /** Reads the mission list and folds it against what is on screen. A failure
     * is reported, never swallowed: a stale list that looks live is the one
     * state a person cannot detect. */
    fun refreshMissions() {
        val client = api ?: return
        runCatching { client.missions() }
            .onSuccess { adoptMissions(it) }
            .onFailure { report(it) }
    }

    private fun report(error: Throwable) {
        when (error) {
            is ApiException -> if (error.isUnauthenticated) signedOut() else errors.tryEmit(error.details.message)
            is NetworkException -> errors.tryEmit("Can't reach your computer right now")
            else -> errors.tryEmit(error.message ?: "Something went wrong")
        }
    }

    private fun disconnect() {
        live?.stop()
        live = null
    }

    fun statusOf(missionId: String): MissionStatus? = missionState.value[missionId]?.status

    companion object {
        /** How long one mission's one kind of notification stays suppressed. */
        const val NOTIFICATION_THROTTLE_MS: Long = 60_000

        /** A URL with no path, for a person who typed a host and a port. */
        fun normalise(value: String): HttpUrl? = CoreUrl.normalize(value)
    }
}
