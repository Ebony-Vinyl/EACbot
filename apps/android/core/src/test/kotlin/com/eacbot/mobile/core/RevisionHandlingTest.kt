package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Revision handling as a client must do it: send the revision on screen, and
 * when the server refuses it, read the revision the server actually holds
 * instead of guessing the next one.
 */
class RevisionHandlingTest {

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

    @Test
    fun `a command adopts the revision the server returns, not a guessed one`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"commandId":"c-1","type":"run.steer","missionId":"m-1","appliedAt":"t","missionRevision":9,"replayed":false}""",
            ),
        )
        val result = api().execute(MissionCommands.steer("m-1", 8, "go left", "c-1"))
        assertEquals(9, result.missionRevision)
        // 9, not 8 + 1: the server may apply several effects for one command.
        assertTrue(result.missionRevision > 8)
    }

    @Test
    fun `a stale revision is refused with both numbers so the caller can refetch`() {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"error":{"code":"revision_conflict","message":"stale","details":{"expected":4,"actual":7}}}""",
            ),
        )
        val error = runCatching { api().execute(MissionCommands.cancel("m-1", 4, "c-1")) }.exceptionOrNull()
        assertTrue(error is ApiException)
        error as ApiException
        assertTrue(error.isRevisionConflict)
        assertEquals(4, error.details.expectedRevision)
        assertEquals(7, error.details.actualRevision)
    }

    @Test
    fun `a retried command keeps its id so the server replays instead of acting twice`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"commandId":"same-id","type":"mission.cancel","missionId":"m-1","appliedAt":"t","missionRevision":10,"replayed":false}""",
            ),
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"commandId":"same-id","type":"mission.cancel","missionId":"m-1","appliedAt":"t","missionRevision":10,"replayed":true}""",
            ),
        )
        val first = api().execute(MissionCommands.cancel("m-1", 9, "same-id"))
        val retry = api().execute(MissionCommands.cancel("m-1", 9, "same-id"))
        assertEquals(false, first.replayed)
        assertEquals(true, retry.replayed)
        assertEquals(first.missionRevision, retry.missionRevision)

        val firstBody = server.takeRequest().body.readUtf8()
        val retryBody = server.takeRequest().body.readUtf8()
        assertEquals("a retry is the same request", firstBody, retryBody)
    }

    @Test
    fun `an illegal transition is reported as such, not as a network failure`() {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"error":{"code":"illegal_transition","message":"mission cannot move from succeeded to running"}}""",
            ),
        )
        val error = runCatching { api().execute(MissionCommands.resume("m-1", 3, "c-1")) }.exceptionOrNull()
        assertTrue(error is ApiException)
        assertEquals("illegal_transition", (error as ApiException).details.code)
    }

    @Test
    fun `a capability refusal is a 422 with a code the screen can explain`() {
        server.enqueue(
            MockResponse().setResponseCode(422).setBody(
                """{"error":{"code":"capability_missing","message":"codex cannot resume a run"}}""",
            ),
        )
        val error = runCatching { api().execute(MissionCommands.resume("m-1", 3, "c-1")) }.exceptionOrNull()
        assertEquals("capability_missing", (error as ApiException).details.code)
        assertEquals(422, (error as ApiException).status)
    }

    @Test
    fun `the reconcile command names a run and an action`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"commandId":"c-9","type":"run.reconcile","missionId":"m-1","appliedAt":"t","missionRevision":2,"replayed":false,"runId":"r-1"}""",
            ),
        )
        api().execute(MissionCommands.reconcile("m-1", 1, "r-1", "abandon", "c-9"))
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"action\":\"abandon\""))
        assertTrue(body.contains("\"runId\":\"r-1\""))
    }

    @Test
    fun `an approval answer carries the text and nothing else decides it`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"commandId":"c-2","type":"approval.resolve","missionId":"m-1","appliedAt":"t","missionRevision":5,"replayed":false}""",
            ),
        )
        api().execute(MissionCommands.resolveApproval("m-1", "a-1", 4, "answer", "c-2", answer = "use the archive"))
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"decision\":\"answer\""))
        assertTrue(body.contains("\"answer\":\"use the archive\""))
    }

    @Test
    fun `a mission revision moves only when the server says so`() {
        val mission = WireCodec.mission(
            wireJson.parseToJsonElement(
                """{"id":"m-1","title":"t","prompt":"p","status":"running","revision":12}""",
            ) as JsonObject,
        )!!
        assertEquals(12, mission.revision)
        assertNull(mission.error)
    }
}
