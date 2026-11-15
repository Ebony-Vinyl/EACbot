package com.eacbot.mobile.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class CoreApiTest {

    private lateinit var server: MockWebServer
    private var token: String? = "device-token-123456"
    private var unauthorizedCalls = 0

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
        tokens = { token },
        onUnauthorized = { unauthorizedCalls += 1 },
    )

    private fun enqueue(code: Int, body: String) {
        server.enqueue(MockResponse().setResponseCode(code).setBody(body).setHeader("content-type", "application/json"))
    }

    @Test
    fun `every request carries the bearer`() {
        enqueue(200, """{"missions":[]}""")
        api().missions()
        val recorded = server.takeRequest()
        assertEquals("Bearer device-token-123456", recorded.getHeader("authorization"))
        assertEquals("/api/v1/missions", recorded.path)
    }

    @Test
    fun `pairing claim is the one unauthenticated call`() {
        enqueue(201, """{"token":"new-token","session":{"id":"s","label":"Pixel","scope":"device","expiresAt":"x"}}""")
        val result = api().claimPairing("ABCD-EFGH", "Pixel")
        assertEquals("new-token", result.token)
        val recorded = server.takeRequest()
        assertNull(recorded.getHeader("authorization"))
        assertTrue(recorded.body.readUtf8().contains("\"code\":\"ABCD-EFGH\""))
    }

    @Test
    fun `a 401 reports once and throws so the app can clear the session`() {
        enqueue(401, """{"error":{"code":"session_revoked","message":"this device was signed out"}}""")
        try {
            api().missions()
            fail("a revoked session must throw")
        } catch (error: ApiException) {
            assertTrue(error.isUnauthenticated)
            assertEquals("session_revoked", error.details.code)
        }
        assertEquals(1, unauthorizedCalls)
    }

    @Test
    fun `a 403 is not treated as a lost session`() {
        enqueue(403, """{"error":{"code":"forbidden","message":"this call needs the owner scope"}}""")
        try {
            api().missions()
            fail("a scope refusal must throw")
        } catch (error: ApiException) {
            assertFalse(error.isUnauthenticated)
            assertTrue(error.isForbidden)
        }
        assertEquals(0, unauthorizedCalls)
    }

    @Test
    fun `a revision conflict exposes the revision the server holds`() {
        enqueue(
            409,
            """{"error":{"code":"revision_conflict","message":"stale","details":{"expected":3,"actual":5}}}""",
        )
        try {
            api().execute(MissionCommands.steer("m-1", 3, "x", "c-1"))
            fail("a stale revision must throw")
        } catch (error: ApiException) {
            assertTrue(error.isRevisionConflict)
            assertEquals(3, error.details.expectedRevision)
            assertEquals(5, error.details.actualRevision)
        }
    }

    @Test
    fun `a mutation posts its body to the encoded path`() {
        enqueue(200, """{"commandId":"c-1","type":"run.steer","missionId":"m/1","appliedAt":"t","missionRevision":4,"replayed":false}""")
        val result = api().execute(MissionCommands.steer("m/1", 3, "go left", "c-1"))
        assertEquals(4, result.missionRevision)
        val recorded = server.takeRequest()
        assertEquals("/api/v1/missions/m%2F1/steer", recorded.path)
        val body = recorded.body.readUtf8()
        assertTrue(body.contains("\"expectedRevision\":3"))
        assertTrue(body.contains("\"input\":\"go left\""))
    }

    @Test
    fun `history asks from the cursor it was given`() {
        enqueue(200, """{"events":[],"nextSeq":41}""")
        val page = api().history("m-1", sinceSeq = 41)
        assertEquals(41L, page.nextSeq)
        assertEquals("/api/v1/missions/m-1/history?since=41", server.takeRequest().path)
    }

    @Test
    fun `a ticket request is a POST bound to one terminal`() {
        enqueue(201, """{"ticket":"abc","expiresAt":"t","path":"/api/v1/terminals/t-1/stream"}""")
        val ticket = api().terminalTicket("t-1")
        assertEquals("abc", ticket.ticket)
        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/api/v1/terminals/t-1/ticket", recorded.path)
    }

    @Test
    fun `revoking a device deletes exactly that session`() {
        server.enqueue(MockResponse().setResponseCode(204))
        api().revokeSession("s-1")
        val recorded = server.takeRequest()
        assertEquals("DELETE", recorded.method)
        assertEquals("/api/v1/sessions/s-1", recorded.path)
    }

    @Test
    fun `a transport failure is a network error, not an api error`() {
        server.shutdown()
        try {
            api().missions()
            fail("a closed server must throw")
        } catch (error: NetworkException) {
            assertTrue(error.message!!.isNotEmpty())
        }
    }

    @Test
    fun `a malformed success body degrades instead of crashing`() {
        enqueue(200, """{"missions":"not a list"}""")
        assertTrue(api().missions().isEmpty())
    }

    @Test
    fun `an empty success body is not a parse failure`() {
        server.enqueue(MockResponse().setResponseCode(204))
        api().revokeAllSessions()
        assertEquals("POST", server.takeRequest().method)
    }
}
