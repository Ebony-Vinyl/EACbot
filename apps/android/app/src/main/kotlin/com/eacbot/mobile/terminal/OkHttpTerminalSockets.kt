package com.eacbot.mobile.terminal

import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.TerminalSocket
import com.eacbot.mobile.core.TerminalSocketFactory
import com.eacbot.mobile.core.TerminalSocketListener
import com.eacbot.mobile.core.TerminalTicket
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/**
 * The terminal socket, over OkHttp's WebSocket.
 *
 * The server's text frames are control messages and its binary frames are raw
 * program output; this bridge keeps that distinction instead of flattening both
 * to strings, because terminal bytes are not UTF-8 and must not be decoded
 * here.
 */
class OkHttpTerminalSockets(
    private val api: CoreApi,
    private val client: OkHttpClient = defaultClient(),
) : TerminalSocketFactory {

    override fun open(ticket: TerminalTicket, listener: TerminalSocketListener): TerminalSocket {
        val path = ticket.path.ifEmpty {
            "/api/v1/terminals/${java.net.URLEncoder.encode(ticket.ticket, "UTF-8")}/stream"
        }
        val url = com.eacbot.mobile.core.CoreUrl.webSocketUrl(api.base, path, ticket.ticket)
        val bridge = OkHttpTerminalSocket(listener)
        val socket = client.newWebSocket(Request.Builder().url(url).build(), bridge)
        bridge.attach(socket)
        return bridge
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            // A terminal is idle between keystrokes; a read timeout would drop a
            // session nobody is typing into.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }
}

private class OkHttpTerminalSocket(
    listener: TerminalSocketListener,
) : TerminalSocket, WebSocketListener() {

    private val sink = listener

    @Volatile
    private var socket: WebSocket? = null
    @Volatile
    private var closed = false
    @Volatile
    private var reported = false

    fun attach(socket: WebSocket) {
        this.socket = socket
        if (closed) socket.cancel()
    }

    override fun sendText(text: String) {
        socket?.send(text)
    }

    override fun sendBinary(bytes: ByteArray) {
        socket?.send(bytes.toByteString())
    }

    override fun close() {
        if (closed) return
        closed = true
        socket?.close(NORMAL_CLOSURE, "leaving the terminal")
        socket = null
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        sink.onText(text)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        sink.onBinary(bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
        report(code, reason)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        report(code, reason)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        report(1006, t.message ?: "连接失败")
    }

    /** A close is reported once: `onClosing` and `onClosed` both arrive for a
     * clean shutdown, and a retry scheduled twice would double the stream. */
    private fun report(code: Int, reason: String) {
        if (reported) return
        reported = true
        sink.onClosed(code, reason)
    }

    companion object {
        const val NORMAL_CLOSURE = 1000
    }
}
