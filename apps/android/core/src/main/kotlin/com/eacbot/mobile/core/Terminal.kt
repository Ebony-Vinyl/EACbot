package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject

/**
 * The terminal WebSocket contract a viewer speaks (`core/terminal/stream.ts`).
 *
 * Server text: `ready`, `title`, `status`, `exit`, `error`, `resync`.
 * Server binary: raw program output.
 * Client binary: raw input, only while the viewer holds control.
 * Client text: `resize`, `credit`, `close`.
 *
 * `ready` and `resync` are repaint boundaries: the screen starts over from the
 * bytes that follow, so a reconnect never doubles text. A dropped stream keeps
 * the last screen until the next `ready` replaces it, and no input is ever
 * replayed.
 */
sealed interface TerminalControl {
    data class Ready(
        val terminalId: String,
        val cols: Int,
        val rows: Int,
        val canControl: Boolean,
    ) : TerminalControl

    data class Title(val title: String) : TerminalControl

    data class Status(val status: String) : TerminalControl

    data class Exit(val reason: String, val exitCode: Int?) : TerminalControl

    data class Error(val code: String, val message: String) : TerminalControl

    /** The core's line dropped under the stream. The terminal itself survives on
     * the core, so the viewer attaches again and gets a fresh paint. */
    data class Resync(val reason: String) : TerminalControl
}

object TerminalCodec {

    /** Decodes one text frame. An unknown `type` is dropped: a control message
     * this client does not understand is not program output. */
    fun parseControl(text: String): TerminalControl? {
        val record = runCatching { wireJson.parseToJsonElement(text).asObjectOrNull() }.getOrNull() ?: return null
        return when (record.stringOrNull("type")) {
            "ready" -> {
                val terminalId = record.stringOrNull("terminalId") ?: return null
                val cols = record.intOrNull("cols") ?: return null
                val rows = record.intOrNull("rows") ?: return null
                TerminalControl.Ready(
                    terminalId = terminalId,
                    cols = cols,
                    rows = rows,
                    canControl = record.booleanOrNull("canControl") == true,
                )
            }
            "title" -> record.stringOrNull("title")?.let(TerminalControl::Title)
            "status" -> record.stringOrNull("status")?.let(TerminalControl::Status)
            "exit" -> TerminalControl.Exit(
                reason = record.stringOrNull("reason") ?: "exited",
                exitCode = record.intOrNull("exitCode"),
            )
            "error" -> TerminalControl.Error(
                code = record.stringOrNull("code") ?: "error",
                message = record.stringOrNull("message") ?: "the terminal stream reported an error",
            )
            "resync" -> TerminalControl.Resync(record.stringOrNull("reason") ?: "disconnected")
            else -> null
        }
    }

    fun resize(cols: Int, rows: Int): String =
        """{"type":"resize","cols":${cols.coerceAtLeast(1)},"rows":${rows.coerceAtLeast(1)}}"""

    fun credit(bytes: Int): String = """{"type":"credit","bytes":${bytes.coerceAtLeast(0)}}"""

    val close: String = """{"type":"close"}"""

    /** Whether a viewer may type at all. `observe` never may, whatever the
     * server's `ready` said: the app's own mode wins locally too, so a mistake
     * in the UI cannot put bytes on someone else's shell. */
    fun mayType(role: TerminalRole, readyCanControl: Boolean): Boolean =
        role == TerminalRole.Control && readyCanControl
}

enum class TerminalRole { Control, Observe }

/**
 * Flow control for the terminal stream: the server grants a window and the
 * viewer returns credit for bytes the terminal has actually drawn.
 *
 * Credit goes back after the renderer consumed a chunk, never on receipt, so a
 * slow screen slows the stream instead of dropping output. A repaint starts a
 * fresh screen, so bytes still being drawn are not credited twice.
 */
data class CreditLedger(
    /** Bytes received and not yet credited. */
    val pending: Int = 0,
    /** The window as this client counts it down. */
    val window: Int = INITIAL_CREDIT_BYTES,
) {
    fun received(bytes: Int): CreditLedger {
        if (bytes <= 0) return this
        return copy(pending = pending + bytes, window = (window - bytes).coerceAtLeast(0))
    }

    /** Credits everything drawn so far; `credit` is what to send back. */
    fun drawn(): Pair<CreditLedger, Int> {
        if (pending <= 0) return this to 0
        return copy(pending = 0, window = window + pending) to pending
    }

    fun repainted(): CreditLedger = copy(pending = 0, window = maxOf(window, INITIAL_CREDIT_BYTES))

    companion object {
        /** Credit an attach stream starts with before the viewer acknowledges
         * bytes (`core/terminal/wire.ts`). */
        const val INITIAL_CREDIT_BYTES = 256 * 1024
    }
}

/** A terminal frame the server sent, as bytes plus the boundary it implies. */
sealed interface TerminalEvent {
    data class Data(val bytes: ByteArray) : TerminalEvent {
        override fun equals(other: Any?): Boolean = other is Data && bytes.contentEquals(other.bytes)
        override fun hashCode(): Int = bytes.contentHashCode()
    }

    /** The next bytes start a fresh screen. */
    data class Repaint(val cols: Int, val rows: Int) : TerminalEvent

    data class Title(val title: String) : TerminalEvent

    data class Status(val status: String) : TerminalEvent

    data class Exit(val reason: String, val exitCode: Int?) : TerminalEvent

    data class Failed(val code: String, val message: String, val fatal: Boolean) : TerminalEvent

    data class State(val state: TerminalConnectionState) : TerminalEvent
}

sealed interface TerminalConnectionState {
    data object Idle : TerminalConnectionState

    data class Connecting(val attempt: Int) : TerminalConnectionState

    data class Live(val cols: Int, val rows: Int, val canControl: Boolean) : TerminalConnectionState

    data class Reconnecting(val attempt: Int, val delayMs: Long) : TerminalConnectionState

    data class Exited(val reason: String, val exitCode: Int?) : TerminalConnectionState

    data class Failed(val code: String, val message: String, val retryable: Boolean) : TerminalConnectionState

    data object Closed : TerminalConnectionState
}

/** The socket as the transport sees it. Injectable so a test can drive the
 * protocol without a network. */
interface TerminalSocket {
    fun sendText(text: String)
    fun sendBinary(bytes: ByteArray)
    fun close()
}

interface TerminalSocketListener {
    fun onText(text: String)
    fun onBinary(bytes: ByteArray)
    fun onClosed(code: Int, reason: String)
}

/** Opens the upgraded socket for a ticket. */
fun interface TerminalSocketFactory {
    fun open(ticket: TerminalTicket, listener: TerminalSocketListener): TerminalSocket
}

interface TerminalConnection {
    val terminalId: String
    val role: TerminalRole
    val canControl: Boolean
    val state: TerminalConnectionState
    fun open()
    fun resize(cols: Int, rows: Int)
    /** Sends keystrokes; false when this viewer may not type. */
    fun send(bytes: ByteArray): Boolean
    /** Returns credit for bytes the screen drew. Flow control, not input: an
     * observer sends it too. */
    fun acknowledge(bytes: Int)
    fun setRole(role: TerminalRole)
    fun retry()
    fun close()
    fun setSize(cols: Int, rows: Int)
}

/**
 * The terminal transport: ticket, socket, credit, reconnect.
 *
 * Reconnect mints a fresh ticket and reattaches; it never replays input. A role
 * change is a reattach too, because control is granted per stream.
 */
class TerminalTransport(
    override val terminalId: String,
    private val tickets: (String) -> TerminalTicket,
    private val sockets: TerminalSocketFactory,
    initialRole: TerminalRole = TerminalRole.Observe,
    initialCols: Int = 80,
    initialRows: Int = 24,
    private val baseDelayMs: Long = 500,
    private val maxDelayMs: Long = 10_000,
    private val maxAttempts: Int = 6,
    private val scheduler: (delayMs: Long, run: () -> Unit) -> Cancellable = DefaultScheduler,
    private val listener: (TerminalEvent) -> Unit,
) : TerminalConnection {

    override var role: TerminalRole = initialRole
        private set

    override var state: TerminalConnectionState = TerminalConnectionState.Idle
        private set

    override var canControl: Boolean = false
        private set

    private var cols = initialCols
    private var rows = initialRows
    private var socket: TerminalSocket? = null
    private var stopped = true
    private var exited = false
    private var attempt = 0
    private var generation = 0
    private var scheduled: Cancellable? = null
    private var ledger = CreditLedger()

    override fun open() {
        if (!stopped) return
        stopped = false
        exited = false
        attempt = 0
        attach()
    }

    override fun setSize(cols: Int, rows: Int) {
        this.cols = cols.coerceIn(1, 65_535)
        this.rows = rows.coerceIn(1, 65_535)
    }

    override fun resize(cols: Int, rows: Int) {
        setSize(cols, rows)
        if (!TerminalCodec.mayType(role, canControl)) return
        if (state !is TerminalConnectionState.Live) return
        socket?.sendText(TerminalCodec.resize(this.cols, this.rows))
    }

    override fun send(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return false
        if (!TerminalCodec.mayType(role, canControl)) return false
        if (state !is TerminalConnectionState.Live) return false
        val current = socket ?: return false
        current.sendBinary(bytes)
        return true
    }

    override fun acknowledge(bytes: Int) {
        if (bytes <= 0) return
        if (state !is TerminalConnectionState.Live) return
        socket?.sendText(TerminalCodec.credit(bytes))
    }

    override fun setRole(role: TerminalRole) {
        if (this.role == role) return
        this.role = role
        if (stopped || exited) return
        // Control is granted per stream, so a role change reattaches.
        scheduled?.cancel()
        scheduled = null
        dropSocket()
        attempt = 0
        attach()
    }

    override fun retry() {
        if (state !is TerminalConnectionState.Reconnecting && state !is TerminalConnectionState.Failed) return
        scheduled?.cancel()
        scheduled = null
        attempt = 0
        attach()
    }

    override fun close() {
        if (stopped) return
        stopped = true
        scheduled?.cancel()
        scheduled = null
        val current = socket
        socket = null
        generation += 1
        if (current != null) {
            runCatching { current.sendText(TerminalCodec.close) }
            runCatching { current.close() }
        }
        setState(TerminalConnectionState.Closed)
    }

    private fun attach() {
        if (stopped) return
        val current = ++generation
        setState(
            if (attempt == 0) TerminalConnectionState.Connecting(0)
            else TerminalConnectionState.Reconnecting(attempt, 0),
        )
        val ticket = try {
            tickets(terminalId)
        } catch (error: Throwable) {
            if (current != generation) return
            scheduleRetry(error.message ?: "the ticket request failed")
            return
        }
        if (current != generation || stopped) return

        val opened = try {
            sockets.open(ticket, object : TerminalSocketListener {
                override fun onText(text: String) {
                    if (current == generation) this@TerminalTransport.onText(text)
                }

                override fun onBinary(bytes: ByteArray) {
                    if (current == generation) this@TerminalTransport.onBinary(bytes)
                }

                override fun onClosed(code: Int, reason: String) {
                    if (current == generation) this@TerminalTransport.onSocketClosed()
                }
            })
        } catch (error: Throwable) {
            if (current != generation) return
            scheduleRetry(error.message ?: "the socket did not open")
            return
        }
        if (current != generation || stopped) {
            runCatching { opened.close() }
            return
        }
        socket = opened
    }

    private fun onText(text: String) {
        val control = TerminalCodec.parseControl(text) ?: return
        when (control) {
            is TerminalControl.Ready -> {
                canControl = TerminalCodec.mayType(role, control.canControl)
                cols = control.cols
                rows = control.rows
                ledger = CreditLedger()
                attempt = 0
                setState(TerminalConnectionState.Live(control.cols, control.rows, canControl))
                listener(TerminalEvent.Repaint(control.cols, control.rows))
            }
            is TerminalControl.Resync -> {
                ledger = ledger.repainted()
                listener(TerminalEvent.Repaint(cols, rows))
                // The core dropped the line under the stream. Attach again with
                // a fresh ticket rather than pretending the screen is current.
                dropSocket()
                scheduleRetry(control.reason)
            }
            is TerminalControl.Title -> listener(TerminalEvent.Title(control.title))
            is TerminalControl.Status -> listener(TerminalEvent.Status(control.status))
            is TerminalControl.Exit -> {
                exited = true
                setState(TerminalConnectionState.Exited(control.reason, control.exitCode))
                listener(TerminalEvent.Exit(control.reason, control.exitCode))
                dropSocket()
            }
            is TerminalControl.Error -> {
                // `not_controller` means this viewer may watch but not type: the
                // server's answer wins and input stops, but the screen stays.
                if (control.code == "not_controller") canControl = false
                val fatal = control.code != "not_controller"
                listener(TerminalEvent.Failed(control.code, control.message, fatal))
                if (fatal) {
                    setState(TerminalConnectionState.Failed(control.code, control.message, retryable = true))
                    dropSocket()
                }
            }
        }
    }

    private fun onBinary(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        ledger = ledger.received(bytes.size)
        listener(TerminalEvent.Data(bytes))
    }

    private fun onSocketClosed() {
        socket = null
        if (stopped || exited) return
        if (state is TerminalConnectionState.Failed) return
        scheduleRetry("the stream closed")
    }

    private fun scheduleRetry(reason: String) {
        if (stopped) return
        attempt += 1
        if (attempt > maxAttempts) {
            setState(TerminalConnectionState.Failed("stream_lost", reason, retryable = true))
            return
        }
        val delay = minOf(maxDelayMs, baseDelayMs * (1L shl minOf(attempt - 1, 5)))
        setState(TerminalConnectionState.Reconnecting(attempt, delay))
        scheduled?.cancel()
        scheduled = scheduler(delay) {
            scheduled = null
            if (!stopped) attach()
        }
    }

    private fun dropSocket() {
        val current = socket
        socket = null
        generation += 1
        if (current != null) runCatching { current.close() }
    }

    private fun setState(next: TerminalConnectionState) {
        state = next
        listener(TerminalEvent.State(next))
    }
}

/** Whether a role may send input at all, before any server answer. */
fun mayType(role: TerminalRole): Boolean = role == TerminalRole.Control
