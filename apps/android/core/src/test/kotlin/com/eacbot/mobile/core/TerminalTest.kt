package com.eacbot.mobile.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalTest {

    // ---- frame decoding ----------------------------------------------------

    @Test
    fun `ready carries the size and whether this viewer may type`() {
        val control = TerminalCodec.parseControl("""{"type":"ready","terminalId":"t-1","cols":120,"rows":40,"canControl":true}""")
        val ready = control as TerminalControl.Ready
        assertEquals("t-1", ready.terminalId)
        assertEquals(120, ready.cols)
        assertEquals(40, ready.rows)
        assertTrue(ready.canControl)
    }

    @Test
    fun `ready without a size is refused rather than defaulted`() {
        assertNull(TerminalCodec.parseControl("""{"type":"ready","terminalId":"t-1","canControl":true}"""))
        assertNull(TerminalCodec.parseControl("""{"type":"ready","cols":80,"rows":24,"canControl":true}"""))
    }

    @Test
    fun `title status exit error and resync decode`() {
        assertEquals(TerminalControl.Title("zsh"), TerminalCodec.parseControl("""{"type":"title","title":"zsh"}"""))
        assertEquals(TerminalControl.Status("needs-a-human"), TerminalCodec.parseControl("""{"type":"status","status":"needs-a-human"}"""))
        assertEquals(TerminalControl.Exit("exited", 1), TerminalCodec.parseControl("""{"type":"exit","reason":"exited","exitCode":1}"""))
        assertEquals(TerminalControl.Exit("exited", null), TerminalCodec.parseControl("""{"type":"exit","reason":"exited"}"""))
        assertEquals(
            TerminalControl.Error("not_controller", "an observer may watch but not type"),
            TerminalCodec.parseControl("""{"type":"error","code":"not_controller","message":"an observer may watch but not type"}"""),
        )
        assertEquals(TerminalControl.Resync("disconnected"), TerminalCodec.parseControl("""{"type":"resync","reason":"disconnected"}"""))
    }

    @Test
    fun `an unknown control type is dropped`() {
        assertNull(TerminalCodec.parseControl("""{"type":"paint","colour":"red"}"""))
        assertNull(TerminalCodec.parseControl("not json"))
    }

    @Test
    fun `client control messages are the three the server accepts`() {
        assertEquals("""{"type":"resize","cols":100,"rows":30}""", TerminalCodec.resize(100, 30))
        assertEquals("""{"type":"resize","cols":1,"rows":1}""", TerminalCodec.resize(0, -5))
        assertEquals("""{"type":"credit","bytes":4096}""", TerminalCodec.credit(4096))
        assertEquals("""{"type":"close"}""", TerminalCodec.close)
    }

    // ---- observe restrictions ---------------------------------------------

    @Test
    fun `observe never types even when the server says it could`() {
        assertFalse(TerminalCodec.mayType(TerminalRole.Observe, readyCanControl = true))
        assertFalse(TerminalCodec.mayType(TerminalRole.Observe, readyCanControl = false))
        assertFalse(TerminalCodec.mayType(TerminalRole.Control, readyCanControl = false))
        assertTrue(TerminalCodec.mayType(TerminalRole.Control, readyCanControl = true))
    }

    @Test
    fun `an observer transport refuses input and resize but still credits`() {
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            initialRole = TerminalRole.Observe,
            listener = {},
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":true}""")

        assertFalse(transport.send("ls\n".toByteArray()))
        transport.resize(100, 30)
        transport.acknowledge(1024)

        val sent = sockets.last().sentText
        assertTrue("an observer must not resize", sent.none { it.contains("\"type\":\"resize\"") })
        assertTrue("an observer must not type", sockets.last().sentBinary.isEmpty())
        assertTrue("an observer still returns credit", sent.any { it.contains("\"type\":\"credit\"") })
    }

    @Test
    fun `a controller types only after ready grants it`() {
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            initialRole = TerminalRole.Control,
            listener = {},
        )
        transport.open()
        assertFalse("typing before ready would go nowhere", transport.send("x".toByteArray()))

        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":true}""")
        assertTrue(transport.send("x".toByteArray()))
        assertArrayEquals("x".toByteArray(), sockets.last().sentBinary.single())

        transport.resize(120, 40)
        assertTrue(sockets.last().sentText.any { it.contains("\"type\":\"resize\"") })
    }

    @Test
    fun `a not_controller refusal stops input but keeps the screen`() {
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val events = mutableListOf<TerminalEvent>()
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            initialRole = TerminalRole.Control,
            listener = { events += it },
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":true}""")
        sockets.last().emitText("""{"type":"error","code":"not_controller","message":"an observer may watch but not type"}""")

        assertFalse(transport.canControl)
        assertFalse(transport.send("x".toByteArray()))
        assertTrue(events.any { it is TerminalEvent.Failed && it.code == "not_controller" })
        assertTrue("a refusal is not fatal", transport.state is TerminalConnectionState.Live)
    }

    @Test
    fun `a role change reattaches with a fresh ticket because control is per stream`() {
        val tickets = mutableListOf<String>()
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = {
                tickets += "asked"
                TerminalTicket("ticket-${tickets.size}", null, "/api/v1/terminals/t-1/stream")
            },
            sockets = sockets,
            initialRole = TerminalRole.Observe,
            listener = {},
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":false}""")
        transport.setRole(TerminalRole.Control)

        assertEquals(2, tickets.size)
        assertEquals(TerminalRole.Control, transport.role)
    }

    // ---- reconnect --------------------------------------------------------

    @Test
    fun `a dropped stream reattaches and never replays input`() {
        val scheduled = mutableListOf<() -> Unit>()
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            initialRole = TerminalRole.Control,
            scheduler = { _, run -> scheduled += run; Cancellable {} },
            listener = {},
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":true}""")
        transport.send("ls\n".toByteArray())

        sockets.last().emitClosed()
        assertTrue(transport.state is TerminalConnectionState.Reconnecting)
        assertEquals(1, scheduled.size)
        scheduled.removeAt(0).invoke()

        assertEquals(2, sockets.created)
        assertTrue("a reattach must not resend old input", sockets.last().sentBinary.isEmpty())
    }

    @Test
    fun `resync is a repaint boundary that reattaches`() {
        val scheduled = mutableListOf<() -> Unit>()
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val events = mutableListOf<TerminalEvent>()
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            scheduler = { _, run -> scheduled += run; Cancellable {} },
            listener = { events += it },
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":false}""")
        sockets.last().emitText("""{"type":"resync","reason":"disconnected"}""")

        assertTrue(events.any { it is TerminalEvent.Repaint })
        assertEquals(1, scheduled.size)
    }

    @Test
    fun `an exit is terminal and stops reconnecting`() {
        val scheduled = mutableListOf<() -> Unit>()
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            scheduler = { _, run -> scheduled += run; Cancellable {} },
            listener = {},
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":true}""")
        sockets.last().emitText("""{"type":"exit","reason":"exited","exitCode":0}""")

        assertEquals(TerminalConnectionState.Exited("exited", 0), transport.state)
        assertTrue(scheduled.isEmpty())
    }

    @Test
    fun `repeated failures end in a retryable failure instead of an endless loop`() {
        val scheduled = mutableListOf<() -> Unit>()
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { throw NetworkException("down") },
            sockets = sockets,
            scheduler = { _, run -> scheduled += run; Cancellable {} },
            maxAttempts = 2,
            listener = {},
        )
        transport.open()
        assertEquals(1, scheduled.size)
        scheduled.removeAt(0).invoke()
        assertEquals(1, scheduled.size)
        scheduled.removeAt(0).invoke()
        val state = transport.state
        assertTrue(state is TerminalConnectionState.Failed)
        assertTrue((state as TerminalConnectionState.Failed).retryable)
    }

    // ---- credit -----------------------------------------------------------

    @Test
    fun `the ledger starts at the 256 KiB window the core grants`() {
        assertEquals(256 * 1024, CreditLedger().window)
        assertEquals(0, CreditLedger().pending)
    }

    @Test
    fun `credit is returned for bytes received, not on receipt`() {
        var ledger = CreditLedger()
        ledger = ledger.received(4096)
        assertEquals(4096, ledger.pending)
        assertEquals(256 * 1024 - 4096, ledger.window)

        val (credited, amount) = ledger.drawn()
        assertEquals(4096, amount)
        assertEquals(0, credited.pending)
        assertEquals(256 * 1024, credited.window)
    }

    @Test
    fun `credit never goes negative and never returns more than was received`() {
        var ledger = CreditLedger(window = 100)
        ledger = ledger.received(500)
        assertEquals(0, ledger.window)
        assertEquals(500, ledger.pending)
        val (_, amount) = ledger.drawn()
        assertEquals(500, amount)
    }

    @Test
    fun `a repaint drops uncredited bytes so they are not credited twice`() {
        val ledger = CreditLedger().received(2048)
        val repainted = ledger.repainted()
        assertEquals(0, repainted.pending)
        assertEquals(256 * 1024, repainted.window)
        assertEquals(0, repainted.drawn().second)
    }

    @Test
    fun `the transport counts received bytes into the ledger`() {
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val events = mutableListOf<TerminalEvent>()
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream") },
            sockets = sockets,
            listener = { events += it },
        )
        transport.open()
        sockets.last().emitText("""{"type":"ready","terminalId":"t-1","cols":80,"rows":24,"canControl":false}""")
        sockets.last().emitBinary("hello".toByteArray())

        val data = events.filterIsInstance<TerminalEvent.Data>()
        assertEquals(1, data.size)
        assertArrayEquals("hello".toByteArray(), data.single().bytes)
    }

    @Test
    fun `a ticket failure retries rather than losing the terminal`() {
        val scheduled = mutableListOf<() -> Unit>()
        val sockets = FakeSockets(TerminalTicket("ticket-1", null, "/api/v1/terminals/t-1/stream"))
        val transport = TerminalTransport(
            terminalId = "t-1",
            tickets = { throw ApiException(401, ApiErrorDetails("ticket_expired", "the ticket expired")) },
            sockets = sockets,
            scheduler = { _, run -> scheduled += run; Cancellable {} },
            listener = {},
        )
        transport.open()
        assertTrue(transport.state is TerminalConnectionState.Reconnecting)
        assertNotNull(scheduled.singleOrNull())
    }

    /** A socket factory that records every socket it hands out. */
    private class FakeSockets(private val ticket: TerminalTicket) : TerminalSocketFactory {
        private val sockets = mutableListOf<FakeSocket>()
        var created = 0
            private set

        fun last(): FakeSocket = sockets.last()

        override fun open(ticket: TerminalTicket, listener: TerminalSocketListener): TerminalSocket {
            created += 1
            val socket = FakeSocket(listener)
            sockets += socket
            return socket
        }
    }

    private class FakeSocket(private val listener: TerminalSocketListener) : TerminalSocket {
        val sentText = mutableListOf<String>()
        val sentBinary = mutableListOf<ByteArray>()
        private var closed = false

        override fun sendText(text: String) {
            sentText += text
        }

        override fun sendBinary(bytes: ByteArray) {
            sentBinary += bytes
        }

        override fun close() {
            closed = true
        }

        fun emitText(text: String) = listener.onText(text)

        fun emitBinary(bytes: ByteArray) = listener.onBinary(bytes)

        fun emitClosed() {
            if (!closed) listener.onClosed(1006, "dropped")
        }
    }
}
