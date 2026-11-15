package com.eacbot.mobile.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CommandIds
import com.eacbot.mobile.core.ConversationFold
import com.eacbot.mobile.core.ConversationFolder
import com.eacbot.mobile.core.ConversationItem
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionCommandRequest
import com.eacbot.mobile.core.MissionCommands
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.core.UuidCommandIds
import com.eacbot.mobile.core.allowedOperations
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What one conversation screen needs. */
data class ChatUiState(
    val loading: Boolean = true,
    val mission: Mission? = null,
    val fold: ConversationFold = ConversationFolder.empty(),
    val sending: Boolean = false,
    val draft: String = "",
    val error: String? = null,
    /** Set when the log had a gap and the screen must refetch rather than
     * pretend the transcript is whole. */
    val resyncing: Boolean = false,
    val lastSyncedAt: Long? = null,
    val offline: Boolean = false,
) {
    val operations get() = mission?.let { allowedOperations(it) }
}

/**
 * One mission's conversation.
 *
 * The screen folds the append-only log and never invents state. A mutation is
 * sent with a command id and the revision on screen; a `revision_conflict`
 * refetches the mission instead of retrying blind, and a log gap sets
 * [ChatUiState.resyncing] so the transcript is rebuilt rather than patched.
 */
class ChatViewModel(
    private val api: CoreApi,
    private val missionId: String,
    private val commandIds: CommandIds = UuidCommandIds,
    /** Notifications for this mission, so a change shows up as it happens
     * instead of at the next poll. */
    private val hints: kotlinx.coroutines.flow.SharedFlow<com.eacbot.mobile.core.LiveNotification>? = null,
) : ViewModel() {

    private val state = MutableStateFlow(ChatUiState())
    val ui: StateFlow<ChatUiState> = state.asStateFlow()

    /** Only the notifications that name this mission. A hint for another
     * mission is not this screen's business. */
    val liveHints: kotlinx.coroutines.flow.Flow<com.eacbot.mobile.core.LiveNotification> =
        hints?.let { flow ->
            kotlinx.coroutines.flow.flow {
                flow.collect { notification ->
                    if (notification.missionId == null || notification.missionId == missionId) emit(notification)
                }
            }
        } ?: kotlinx.coroutines.flow.emptyFlow()

    private var poller: Job? = null

    fun start() {
        if (poller?.isActive == true) return
        poller = viewModelScope.launch {
            loadSnapshot()
            while (true) {
                delay(POLL_MS)
                if (state.value.mission?.status?.isTerminal == true && state.value.fold.gapAt == null) continue
                sync()
            }
        }
    }

    fun stop() {
        poller?.cancel()
        poller = null
    }

    fun onDraftChange(text: String) {
        state.update { it.copy(draft = text) }
    }

    /** A live hint arrived: read the mission and the next log page. */
    fun onNotification() {
        viewModelScope.launch { sync() }
    }

    fun retry() {
        viewModelScope.launch {
            state.update { it.copy(error = null, loading = true) }
            loadSnapshot()
        }
    }

    fun send() {
        val text = state.value.draft.trim()
        if (text.isEmpty() || state.value.sending) return
        val mission = state.value.mission ?: return
        state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            val request = when (mission.status) {
                MissionStatus.WaitingInput -> MissionCommands.submitInput(
                    mission.id,
                    mission.revision,
                    text,
                    commandIds.next("input"),
                )
                else -> MissionCommands.steer(mission.id, mission.revision, text, commandIds.next("steer"))
            }
            runCommand(request) { state.update { it.copy(draft = "") } }
        }
    }

    fun interrupt() = mutate { mission ->
        MissionCommands.interrupt(mission.id, mission.revision, commandIds.next("interrupt"))
    }

    fun resume() = mutate { mission ->
        MissionCommands.resume(mission.id, mission.revision, commandIds.next("resume"))
    }

    fun cancel(cascade: Boolean = false) = mutate { mission ->
        MissionCommands.cancel(mission.id, mission.revision, commandIds.next("cancel"), cascade = cascade)
    }

    fun resolveApproval(approvalId: String, decision: String, answer: String? = null) = mutate { mission ->
        MissionCommands.resolveApproval(
            missionId = mission.id,
            approvalId = approvalId,
            expectedRevision = mission.revision,
            decision = decision,
            commandId = commandIds.next("approval"),
            answer = answer,
        )
    }

    /** Answers a question the agent is blocked on. It is a `run.submit_input`,
     * not a steer: the run is waiting, and the answer resumes it. */
    fun answerQuestion(text: String) {
        val clean = text.trim()
        if (clean.isEmpty() || state.value.sending) return
        val mission = state.value.mission ?: return
        state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            val request = MissionCommands.submitInput(mission.id, mission.revision, clean, commandIds.next("input"))
            runCommand(request)
        }
    }

    private fun mutate(build: (Mission) -> MissionCommandRequest) {
        val mission = state.value.mission ?: return
        val request = build(mission)
        state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch { runCommand(request) }
    }

    private suspend fun runCommand(request: MissionCommandRequest, onSuccess: () -> Unit = {}) {
        val result = withContext(Dispatchers.IO) { runCatching { api.execute(request) } }
        result
            .onSuccess { outcome ->
                onSuccess()
                state.update { it.copy(sending = false) }
                // The command's own revision is authoritative: adopt it rather
                // than guessing what the next one will be.
                sync(force = true, adoptRevision = outcome.missionRevision)
            }
            .onFailure { error ->
                state.update { it.copy(sending = false, error = describe(error)) }
                if (error is ApiException && error.isRevisionConflict) sync(force = true)
            }
    }

    private suspend fun loadSnapshot() {
        val snapshot = withContext(Dispatchers.IO) {
            runCatching {
                val mission = api.mission(missionId)
                val page = api.history(missionId, sinceSeq = 0, limit = PAGE_LIMIT)
                mission to page
            }
        }
        snapshot
            .onSuccess { (mission, page) ->
                val fold = ConversationFolder.fold(ConversationFolder.empty(), page.events, expectContiguous = false)
                state.update {
                    it.copy(
                        loading = false,
                        mission = mission,
                        fold = fold.copy(nextSeq = page.nextSeq),
                        error = null,
                        offline = false,
                        lastSyncedAt = System.currentTimeMillis(),
                        resyncing = false,
                    )
                }
            }
            .onFailure { error ->
                state.update {
                    it.copy(
                        loading = false,
                        error = describe(error),
                        offline = error is NetworkException,
                    )
                }
            }
    }

    private suspend fun sync(force: Boolean = false, adoptRevision: Int? = null) {
        val current = state.value
        if (!force && current.mission?.status?.isTerminal == true && current.fold.gapAt == null) return
        val result = withContext(Dispatchers.IO) {
            runCatching {
                val mission = api.mission(missionId)
                val page = api.history(missionId, sinceSeq = current.fold.nextSeq, limit = PAGE_LIMIT)
                mission to page
            }
        }
        result
            .onSuccess { (mission, page) ->
                state.update { previous ->
                    val fold = ConversationFolder.fold(previous.fold, page.events)
                    val gap = fold.gapAt
                    previous.copy(
                        loading = false,
                        mission = if (adoptRevision != null) mission.copy(revision = adoptRevision) else mission,
                        fold = fold.copy(nextSeq = maxOf(fold.nextSeq, page.nextSeq)),
                        offline = false,
                        lastSyncedAt = System.currentTimeMillis(),
                        resyncing = gap != null,
                    )
                }
                // A gap means entries were missed: rebuild from a fresh page
                // instead of showing a transcript with a hole in it.
                if (state.value.resyncing) loadSnapshot()
            }
            .onFailure { error ->
                state.update { it.copy(offline = error is NetworkException, error = describe(error)) }
            }
    }

    private fun describe(error: Throwable): String = when (error) {
        is ApiException -> when (error.details.code) {
            "revision_conflict" -> "This mission moved on. Reading the latest state."
            "illegal_transition" -> "That is not possible while the mission is ${state.value.mission?.status?.wire ?: "here"}."
            "capability_missing" -> "This engine cannot do that."
            else -> error.details.message
        }
        is NetworkException -> "Can't reach your computer right now"
        else -> error.message ?: "Something went wrong"
    }

    companion object {
        const val POLL_MS = 4_000L
        const val PAGE_LIMIT = 300
    }
}

/** Items a conversation list renders, newest last. */
fun ChatUiState.items(): List<ConversationItem> = fold.items
