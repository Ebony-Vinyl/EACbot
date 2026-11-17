package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject

/**
 * One `text/event-stream` frame.
 *
 * `id` is the server's monotonic cursor, so a reconnect sends it back as
 * `Last-Event-ID` and the core replays from exactly there
 * (`core/http/sse.ts`, `core/events/hub.ts`).
 */
data class SseFrame(
    val id: String?,
    val event: String?,
    val data: String,
    val retryMs: Int?,
)

/**
 * Incremental SSE parser.
 *
 * A read never respects a frame boundary, so a payload can arrive in pieces and
 * one chunk can hold several frames. A blank line ends a frame; `:` is a
 * comment (the server's keepalive) and is dropped rather than treated as data.
 * A lone `\r` is normalised so a server that ends lines that way still parses.
 */
class SseParser {
    private val data = StringBuilder()
    private var id: String? = null
    private var event: String? = null
    private var retryMs: Int? = null
    private var sawAnyField = false
    private val pending = StringBuilder()

    /** Feeds one chunk and returns every complete frame it completed. */
    fun feed(chunk: String): List<SseFrame> {
        val frames = mutableListOf<SseFrame>()
        pending.append(chunk.replace("\r\n", "\n").replace('\r', '\n'))
        while (true) {
            val newline = pending.indexOf('\n')
            if (newline < 0) break
            val line = pending.substring(0, newline)
            pending.delete(0, newline + 1)
            val frame = line(line) ?: continue
            frames += frame
        }
        return frames
    }

    /** Flushes a frame whose final blank line never arrived because the stream
     * dropped. A partial line is discarded: half an event is not an event. */
    fun flush(): SseFrame? {
        if (pending.isNotEmpty()) {
            // The last line never completed, so nothing that follows it can be
            // trusted to be a whole field.
            pending.clear()
            return null
        }
        return dispatch()
    }

    fun reset() {
        pending.clear()
        data.clear()
        id = null
        event = null
        sawAnyField = false
    }

    private fun line(raw: String): SseFrame? {
        if (raw.isEmpty()) return dispatch()
        if (raw.startsWith(":")) return null
        val colon = raw.indexOf(':')
        val field = if (colon < 0) raw else raw.substring(0, colon)
        val rawValue = if (colon < 0) "" else raw.substring(colon + 1)
        val value = if (rawValue.startsWith(" ")) rawValue.substring(1) else rawValue
        when (field) {
            "data" -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(value)
                sawAnyField = true
            }
            "event" -> {
                event = value
                sawAnyField = true
            }
            "id" -> {
                // An id containing a NUL is invalid and ignored, per the spec.
                if (!value.contains('\u0000')) id = value
                sawAnyField = true
            }
            "retry" -> {
                value.toIntOrNull()?.let { if (it >= 0) retryMs = it }
                sawAnyField = true
            }
            else -> Unit
        }
        return null
    }

    private fun dispatch(): SseFrame? {
        if (!sawAnyField && data.isEmpty() && event == null) return null
        if (data.isEmpty() && event == null) {
            // A frame with only an id or retry updates state but carries nothing.
            sawAnyField = false
            return null
        }
        val frame = SseFrame(id = id, event = event, data = data.toString(), retryMs = retryMs)
        data.clear()
        event = null
        retryMs = null
        sawAnyField = false
        return frame
    }
}

/** The notification the hub publishes. It says *that* something moved and which
 * mission moved; the authoritative state is read over REST. */
data class LiveNotification(
    val cursor: Long,
    val kind: String,
    val at: String,
    val missionId: String? = null,
    val runId: String? = null,
    val revision: Int? = null,
    val reason: String? = null,
) {
    val isResync: Boolean get() = kind == "stream.resync"

    val isShutdown: Boolean get() = kind == "server.shutdown"
}

object NotificationCodec {
    fun parse(frame: SseFrame): LiveNotification? {
        if (frame.data.isBlank()) return null
        val record = runCatching { wireJson.parseToJsonElement(frame.data).asObjectOrNull() }.getOrNull() ?: return null
        val cursor = frame.id?.toLongOrNull() ?: record.longOrNull("cursor") ?: return null
        val kind = record.stringOrNull("kind") ?: frame.event ?: return null
        return LiveNotification(
            cursor = cursor,
            kind = kind,
            at = record.stringOrNull("at") ?: "",
            missionId = record.stringOrNull("missionId"),
            runId = record.stringOrNull("runId"),
            revision = record.intOrNull("revision"),
            reason = record.stringOrNull("reason"),
        )
    }
}

data class SseConnectionState(
    val connected: Boolean,
    val attempt: Int,
    val delayMs: Long,
    val lastCursor: Long?,
)

/**
 * What a live stream reports. `onResync` is the one callback a view must act on
 * by refetching: the server said the client's cursor is too old to replay, so
 * treating the stream as contiguous would show a gap as if it were nothing.
 */
interface LiveEventsListener {
    fun onNotification(notification: LiveNotification)
    fun onResync(reason: String?)
    fun onState(state: SseConnectionState)
}

/** Opens `/api/v1/events` with the device bearer and reads it as SSE.
 *
 * Reconnect order is: send the last cursor as `Last-Event-ID`, replay, then go
 * live. A dropped stream never replays the client's own view; it only re-reads
 * the server's.
 */
interface LiveEventsConnection {
    fun start()
    fun stop()
    /** Reconnects now instead of waiting out the backoff. */
    fun retryNow()
    val lastCursor: Long?
}

class SseLiveEvents(
    private val api: CoreApi,
    private val listener: LiveEventsListener,
    private val client: okhttp3.OkHttpClient = CoreApi.streamingClient(),
    private val baseDelayMs: Long = 1_000,
    private val maxDelayMs: Long = 15_000,
    private val scheduler: (delayMs: Long, run: () -> Unit) -> Cancellable = DefaultScheduler,
) : LiveEventsConnection {

    private var stopped = true
    private var attempt = 0
    private var call: okhttp3.Call? = null
    private var scheduled: Cancellable? = null
    @Volatile
    private var cursor: Long? = null
    @Volatile
    private var generation = 0

    override val lastCursor: Long? get() = cursor

    override fun start() {
        if (!stopped) return
        stopped = false
        attempt = 0
        open()
    }

    override fun stop() {
        if (stopped) return
        stopped = true
        generation += 1
        scheduled?.cancel()
        scheduled = null
        call?.cancel()
        call = null
    }

    override fun retryNow() {
        if (stopped) return
        scheduled?.cancel()
        scheduled = null
        attempt = 0
        call?.cancel()
        open()
    }

    /** A cursor learned from a snapshot, so the first connection replays from
     * there instead of starting at "now". */
    fun seedCursor(value: Long?) {
        cursor = value
    }

    private fun open() {
        if (stopped) return
        val current = ++generation
        val request = try {
            val builder = okhttp3.Request.Builder()
                .url(api.resolve("/api/v1/events"))
                .header("accept", "text/event-stream")
                .header("cache-control", "no-store")
            val token = api.bearer()
            if (token != null) builder.header("authorization", "Bearer $token")
            cursor?.let { builder.header("last-event-id", it.toString()) }
            builder.build()
        } catch (error: Throwable) {
            reportState(connected = false, delayMs = 0)
            return
        }

        val created = client.newCall(request)
        call = created
        reportState(connected = false, delayMs = 0)

        runCatching {
            created.execute().use { response ->
                if (current != generation) return@use
                if (response.code == 401) {
                    listener.onState(SseConnectionState(false, attempt, 0, cursor))
                    // A lost session is not a stream problem: surface it as a
                    // resync so the app clears the credential and re-pairs.
                    listener.onResync("unauthenticated")
                    return@use
                }
                if (!response.isSuccessful) {
                    scheduleRetry()
                    return@use
                }
                val source = response.body?.source() ?: run {
                    scheduleRetry()
                    return@use
                }
                val parser = SseParser()
                attempt = 0
                reportState(connected = true, delayMs = 0)
                while (!stopped && current == generation && !source.exhausted()) {
                    val line = source.readUtf8Line() ?: break
                    // `readUtf8Line` strips the terminator; the parser needs a
                    // frame boundary, so the blank line is preserved by the
                    // empty string it returns for it.
                    parser.feed("$line\n").forEach { frame -> consume(frame) }
                }
                parser.flush()?.let { frame -> consume(frame) }
                if (!stopped && current == generation) scheduleRetry()
            }
        }.onFailure {
            if (!stopped && current == generation) scheduleRetry()
        }
    }

    private fun consume(frame: SseFrame) {
        val notification = NotificationCodec.parse(frame) ?: return
        cursor = notification.cursor
        if (notification.isResync) {
            listener.onResync(notification.reason)
            return
        }
        listener.onNotification(notification)
    }

    private fun scheduleRetry() {
        if (stopped || scheduled != null) return
        attempt += 1
        val delay = minOf(maxDelayMs, baseDelayMs * (1L shl minOf(attempt - 1, 5)))
        reportState(connected = false, delayMs = delay)
        scheduled = scheduler(delay) {
            scheduled = null
            if (!stopped) open()
        }
    }

    private fun reportState(connected: Boolean, delayMs: Long) {
        listener.onState(SseConnectionState(connected, attempt, delayMs, cursor))
    }
}

fun interface Cancellable {
    fun cancel()
}

/** A timer the connection can cancel. Injectable so a test does not wait out a
 * real backoff. */
object DefaultScheduler : (Long, () -> Unit) -> Cancellable {
    override fun invoke(delayMs: Long, run: () -> Unit): Cancellable {
        val future = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "eacbot-sse-retry").apply { isDaemon = true }
        }.schedule(run, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        return Cancellable { future.cancel(false) }
    }
}
