package com.eacbot.mobile.core

import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class LegacyApiTest {
    @Test
    fun `pair does not send existing bearer and fleet uses legacy schema`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"token":"new","session":{"id":"s"}}"""))
            server.enqueue(MockResponse().setBody("""{"bots":[{"id":"b","name":"Bot","threadId":"t","busy":false}]}"""))
            val api = LegacyApi(server.url("/"), { "old" })
            api.pair("code", "phone")
            assertNull(server.takeRequest().getHeader("Authorization"))
            assertEquals("t", api.bots().single().threadId)
            val request = server.takeRequest()
            assertEquals("/api/bots?messages=0", request.path)
            assertEquals("Bearer old", request.getHeader("Authorization"))
        }
    }

    @Test
    fun `send pins conversation and retains caller retry id`() {
        MockWebServer().use { server ->
            repeat(2) { server.enqueue(MockResponse().setBody("{}")) }
            val api = LegacyApi(server.url("/"), { "token" })
            repeat(2) { api.send(LegacyBot("b", "Bot", "fixed-thread"), "hello", "retry-id") }
            repeat(2) {
                val request = server.takeRequest()
                val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                assertEquals("/api/bots/b/messages", request.path)
                assertEquals("fixed-thread", body["threadId"]?.jsonPrimitive?.content)
                assertEquals("retry-id", body["sendId"]?.jsonPrimitive?.content)
            }
        }
    }

    @Test
    fun `revoked session remains a 401 refusal`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"revoked"}"""))
            try { LegacyApi(server.url("/"), { "expired" }).bots(); fail("expected refusal") }
            catch (error: ApiException) { assertEquals(401, error.status) }
        }
    }
}
