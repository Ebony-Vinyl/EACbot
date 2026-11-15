package com.eacbot.mobile.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.Cell
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.core.TerminalConnection
import com.eacbot.mobile.core.TerminalConnectionState
import com.eacbot.mobile.core.TerminalDecoder
import com.eacbot.mobile.core.TerminalEvent
import com.eacbot.mobile.core.TerminalRef
import com.eacbot.mobile.core.TerminalRole
import com.eacbot.mobile.core.TerminalScreen
import com.eacbot.mobile.core.TerminalTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class TerminalUiState(
    val terminal: TerminalRef? = null,
    val title: String = "",
    val status: String? = null,
    val connection: TerminalConnectionState = TerminalConnectionState.Idle,
    val role: TerminalRole = TerminalRole.Observe,
    /** False while the server has not granted control, whatever the local role
     * says. Input is only enabled when both agree. */
    val canType: Boolean = false,
    val cols: Int = 80,
    val rows: Int = 24,
    val lines: List<List<Cell>> = emptyList(),
    val error: String? = null,
    val loading: Boolean = true,
    val exitCode: Int? = null,
) {
    val isLive: Boolean get() = connection is TerminalConnectionState.Live
    val isReconnecting: Boolean get() = connection is TerminalConnectionState.Reconnecting
}

/**
 * One terminal.
 *
 * The screen model is fed by the bytes the server sent, and credit is returned
 * only after those bytes have been drawn: a slow phone slows the stream rather
 * than losing output. An observer never types and never resizes, and the
 * transport refuses both even if the UI asked.
 */
class TerminalViewModel(
    private val api: CoreApi,
    private val terminalId: String,
    private val sockets: OkHttpTerminalSockets = OkHttpTerminalSockets(api),
) : ViewModel() {

    private val state = MutableStateFlow(TerminalUiState())
    val ui: StateFlow<TerminalUiState> = state.asStateFlow()

    private val decoder = TerminalDecoder()
    private var screen = TerminalScreen(80, 24)
    private var transport: TerminalConnection? = null
    private var pendingRepaint = false

    fun start() {
        if (transport != null) return
        viewModelScope.launch {
            val terminal = withContext(Dispatchers.IO) { runCatching { api.terminals().firstOrNull { it.id == terminalId } } }
            state.update { it.copy(terminal = terminal.getOrNull(), loading = false) }
            connect()
        }
    }

    private fun connect() {
        val connection = TerminalTransport(
            terminalId = terminalId,
            tickets = { api.terminalTicket(terminalId) },
            sockets = sockets,
            initialRole = state.value.role,
            initialCols = state.value.cols,
            initialRows = state.value.rows,
            listener = ::onEvent,
        )
        transport = connection
        connection.open()
    }

    fun setRole(role: TerminalRole) {
        if (state.value.role == role) return
        state.update { it.copy(role = role, canType = false) }
        transport?.setRole(role)
    }

    /** Resizes the screen to the container and tells the server, but only while
     * this viewer holds control: an observer's resize would be refused. */
    fun resize(cols: Int, rows: Int) {
        if (cols < 1 || rows < 1) return
        if (cols == state.value.cols && rows == state.value.rows) return
        screen.resize(cols, rows)
        state.update { it.copy(cols = cols, rows = rows, lines = screen.visible()) }
        transport?.resize(cols, rows)
    }

    fun sendInput(bytes: ByteArray) {
        if (!state.value.canType) return
        transport?.send(bytes)
    }

    fun retry() {
        transport?.retry()
    }

    fun close() {
        transport?.close()
        transport = null
    }

    private fun onEvent(event: TerminalEvent) {
        when (event) {
            is TerminalEvent.Data -> {
                val text = decoder.decode(event.bytes)
                if (text.isNotEmpty()) {
                    screen.write(text)
                    state.update { it.copy(lines = screen.visible()) }
                }
                // Credit after the bytes are in the screen model, not on receipt.
                transport?.acknowledge(event.bytes.size)
            }
            is TerminalEvent.Repaint -> {
                pendingRepaint = true
                decoder.flush()
                screen.reset(event.cols, event.rows)
                state.update { it.copy(cols = event.cols, rows = event.rows, lines = screen.visible()) }
                pendingRepaint = false
            }
            is TerminalEvent.Title -> {
                screen.write("")
                state.update { it.copy(title = event.title) }
            }
            is TerminalEvent.Status -> state.update { it.copy(status = event.status) }
            is TerminalEvent.Exit -> state.update {
                it.copy(exitCode = event.exitCode, error = null)
            }
            is TerminalEvent.Failed -> state.update {
                it.copy(error = if (event.fatal) event.message else null)
            }
            is TerminalEvent.State -> state.update {
                val live = event.state as? TerminalConnectionState.Live
                it.copy(
                    connection = event.state,
                    canType = live != null && live.canControl && it.role == TerminalRole.Control,
                )
            }
        }
    }

    override fun onCleared() {
        close()
        super.onCleared()
    }
}
