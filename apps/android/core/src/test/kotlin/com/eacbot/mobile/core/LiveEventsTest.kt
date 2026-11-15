package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The live stream against a real socket, because the reconnect path is exactly
 * the one a unit test with a fake parser would miss: the cursor has to travel
 * as a header on the next connection.
 */
class LiveEventsTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun api(): CoreApi = CoreApi(
        baseUrl = CoreUrl.normalize(server.url("/").toString())!!,
        tokens = { "device-token-123456" },
    )

    private class Recorder : LiveEventsListener {
        val notifications = mutableListOf<LiveNotification>()
        val resyncs = mutableListOf<String?>()
        val states = mutableListOf<SseConnectionState>()
        val received = CountDownLatch(1)
        val retries = AtomicInteger()

        override fun onNotification(notification: LiveNotification) {
            notifications += notification
            received.countDown()
        }

        override fun onResync(reason: String?) {
            resyncs += reason
        }

        override fun onState(state: SseConnectionState) {
            states += state
        }
    }

    private fun sseBody(vararg frames: String): String = frames.joinToString("")

    private fun frame(cursor: Long, kind: String = "mission.updated", missionId: String = "m-1"): String =
        "id: $cursor\nevent: $kind\ndata: {\"cursor\":$cursor,\"kind\":\"$kind\",\"at\":\"2026-11-15T10:00:00Z\",\"missionId\":\"$missionId\"}\n\n"

    @Test
    fun `the stream sends the bearer and asks for the event stream`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("content-type", "text/event-stream")
                .setBody(sseBody(frame(1))),
        )
        val recorder = Recorder()
        val live = SseLiveEvents(api(), recorder)
        live.start()
        assertTrue(recorder.received.await(5, TimeUnit.SECONDS))
        live.stop()

        val recorded = server.takeRequest()
        assertEquals("/api/v1/events", recorded.path)
        assertEquals("Bearer device-token-123456", recorded.getHeader("authorization"))
        assertEquals("text/event-stream", recorded.getHeader("accept"))
    }

    @Test
    fun `a reconnect sends the last cursor as Last-Event-ID`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("content-type", "text/event-stream")
                .setBody(sseBody(frame(7)))
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("content-type", "text/event-stream")
                .setBody(sseBody(frame(8))),
        )

        val recorder = Recorder()
        val scheduled = mutableListOf<() -> Unit>()
        val live = SseLiveEvents(
            api = api(),
            listener = recorder,
            scheduler = { _, run -> scheduled += run; Cancellable {} },
        )
        live.start()
        assertTrue(recorder.received.await(5, TimeUnit.SECONDS))

        val first = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals(null, first.getHeader("last-event-id"))

        // The stream ended, so a retry was scheduled; run it by hand so the test
        // does not wait out a real backoff.
        val retry = awaitCondition { scheduled.isNotEmpty() }
        assertTrue(retry)
        scheduled.removeAt(0).invoke()
        assertTrue(recorder.received.await(5, TimeUnit.SECONDS))

        val second = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("7", second.getHeader("last-event-id"))
        live.stop()
    }

    @Test
    fun `a cursor too old to replay is a resync, not a notification`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("content-type", "text/event-stream")
                .setBody(
                    sseBody(
                        "id: 99\nevent: stream.resync\ndata: {\"kind\":\"stream.resync\",\"cursor\":99,\"reason\":\"cursor_too_old\",\"at\":\"2026-11-15T10:00:00Z\"}\n\n",
                    ),
                )
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END),
        )
        val recorder = Recorder()
        val live = SseLiveEvents(api(), recorder, scheduler = { _, _ -> Cancellable {} })
        live.start()
        val seen = awaitCondition { recorder.resyncs.isNotEmpty() }
        assertTrue(seen)
        assertEquals("cursor_too_old", recorder.resyncs.first())
        assertTrue("a resync is not a task event", recorder.notifications.isEmpty())
        live.stop()
    }

    @Test
    fun `a 401 on the stream is reported as a resync so the app signs out`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"session_revoked","message":"gone"}}"""))
        val recorder = Recorder()
        val live = SseLiveEvents(api(), recorder, scheduler = { _, _ -> Cancellable {} })
        live.start()
        assertTrue(awaitCondition { recorder.resyncs.isNotEmpty() })
        assertEquals("unauthenticated", recorder.resyncs.first())
        live.stop()
    }

    @Test
    fun `a seeded cursor is sent on the first connection`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("content-type", "text/event-stream")
                .setBody(sseBody(frame(20))),
        )
        val recorder = Recorder()
        val live = SseLiveEvents(api(), recorder)
        live.seedCursor(19)
        live.start()
        assertTrue(recorder.received.await(5, TimeUnit.SECONDS))
        assertEquals("19", server.takeRequest().getHeader("last-event-id"))
        live.stop()
    }

    @Test
    fun `stopping the stream does not schedule another attempt`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("content-type", "text/event-stream")
                .setBody(sseBody(frame(1)))
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END),
        )
        val recorder = Recorder()
        val scheduled = mutableListOf<() -> Unit>()
        val live = SseLiveEvents(api(), recorder, scheduler = { _, run -> scheduled += run; Cancellable {} })
        live.start()
        assertTrue(recorder.received.await(5, TimeUnit.SECONDS))
        live.stop()
        val before = scheduled.size
        Thread.sleep(200)
        assertEquals("a stopped stream schedules nothing", before, scheduled.size)
    }

    private fun awaitCondition(timeoutMs: Long = 5_000, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(20)
        }
        return condition()
    }
}

/** The viewer address rules, which are the app's only defence against a core
 * that answers with somebody else's origin. */
class DesktopViewerTest {

    private val base = CoreUrl.normalize("https://core.example.com:8443")!!

    @Test
    fun `a same-origin viewer is accepted`() {
        val entry = DesktopViewer.validate(base, "/novnc/vnc.html?autoconnect=1")
        assertTrue(entry is DesktopEntry.Ready)
        assertEquals("core.example.com", (entry as DesktopEntry.Ready).url.host)
    }

    @Test
    fun `another host is refused`() {
        val entry = DesktopViewer.validate(base, "https://evil.example.com/novnc/vnc.html")
        assertTrue(entry is DesktopEntry.Refused)
    }

    @Test
    fun `another port is refused`() {
        val entry = DesktopViewer.validate(base, "https://core.example.com:9999/novnc/vnc.html")
        assertTrue(entry is DesktopEntry.Refused)
    }

    @Test
    fun `an https core cannot open an http viewer`() {
        val httpBase = CoreUrl.normalize("https://core.example.com")!!
        val entry = DesktopViewer.validate(httpBase, "http://core.example.com/novnc/vnc.html")
        assertTrue(entry is DesktopEntry.Refused)
    }

    @Test
    fun `a non-http scheme is refused`() {
        val entry = DesktopViewer.validate(base, "javascript:alert(1)")
        assertTrue(entry is DesktopEntry.Refused)
    }

    @Test
    fun `no address is unavailable, not a crash`() {
        assertTrue(DesktopViewer.validate(base, null) is DesktopEntry.Unavailable)
    }

    @Test
    fun `a core with no desktop route is not the same as no computer`() {
        val missing = DesktopViewer.fromResponse(
            base,
            wireJson.parseToJsonElement("""{"error":{"code":"not_found","message":"no such route"}}""") as JsonObject,
        )
        assertTrue(missing is DesktopEntry.NotSupported)

        val unavailable = DesktopViewer.fromResponse(
            base,
            wireJson.parseToJsonElement("""{"error":{"code":"no_computer","message":"no computer configured"}}""") as JsonObject,
        )
        assertTrue(unavailable is DesktopEntry.Unavailable)
    }

    @Test
    fun `a response with a url is validated like any other`() {
        val body = wireJson.parseToJsonElement("""{"url":"https://elsewhere.example/novnc/","label":"Build box"}""") as JsonObject
        assertTrue(DesktopViewer.fromResponse(base, body) is DesktopEntry.Refused)
    }
}
