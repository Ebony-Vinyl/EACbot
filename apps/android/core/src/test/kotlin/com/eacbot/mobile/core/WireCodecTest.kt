package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WireCodecTest {

    private fun json(text: String): JsonObject =
        wireJson.parseToJsonElement(text) as JsonObject

    @Test
    fun `mission parses every field the authority sends`() {
        val mission = WireCodec.mission(
            json(
                """
                {
                  "protocolVersion": 1,
                  "id": "m-1",
                  "rootMissionId": "m-1",
                  "depth": 0,
                  "title": "Sort the inbox",
                  "prompt": "Sort it",
                  "agent": "hermes",
                  "model": {"agent": "hermes", "model": "hermes-4", "effort": "high", "label": "Hermes 4"},
                  "environment": {"id": "env-1", "label": "Laptop", "kind": "local", "authMode": "local"},
                  "status": "waiting_input",
                  "revision": 7,
                  "createdAt": "2026-11-15T10:00:00.000Z",
                  "updatedAt": "2026-11-15T10:01:00.000Z",
                  "acceptedAt": "2026-11-15T10:00:00.000Z",
                  "activeRunId": "r-1",
                  "runIds": ["r-1"],
                  "childIds": ["m-2"],
                  "artifactIds": [],
                  "approvalIds": ["a-1"],
                  "wakeGeneration": 2
                }
                """.trimIndent(),
            ),
        )!!

        assertEquals("m-1", mission.id)
        assertEquals(MissionStatus.WaitingInput, mission.status)
        assertEquals(7, mission.revision)
        assertEquals(AgentKind.Hermes, mission.agent)
        assertEquals("hermes-4", mission.model?.model)
        assertEquals("Hermes 4", mission.model?.display)
        assertEquals("Laptop", mission.environment?.label)
        assertEquals(listOf("m-2"), mission.childIds)
        assertEquals(2, mission.wakeGeneration)
    }

    @Test
    fun `an unknown agent stays readable but is not offered as a choice`() {
        val mission = WireCodec.mission(
            json("""{"id":"m-1","title":"t","prompt":"p","agent":"futureEngine","status":"running","revision":1}"""),
        )!!
        assertNull(mission.agent)
        assertEquals("futureEngine", mission.rawAgent)
    }

    @Test
    fun `a mission missing a required field is dropped, not guessed`() {
        assertNull(WireCodec.mission(json("""{"id":"m-1","title":"t"}""")))
        assertNull(WireCodec.mission(json("""{"title":"t","prompt":"p","status":"running","revision":1}""")))
    }

    @Test
    fun `an unknown status is dropped rather than shown as running`() {
        assertNull(
            WireCodec.mission(json("""{"id":"m-1","title":"t","prompt":"p","status":"teleporting","revision":1}""")),
        )
    }

    @Test
    fun `an absent optional field stays absent instead of null`() {
        val mission = WireCodec.mission(
            json("""{"id":"m-1","title":"t","prompt":"p","status":"queued","revision":0}"""),
        )!!
        assertNull(mission.parentMissionId)
        assertNull(mission.activeRunId)
        assertNull(mission.error)
        assertTrue(mission.childIds.isEmpty())
    }

    @Test
    fun `agent capabilities decode a steer mode and default the rest to false`() {
        val agent = WireCodec.agent(
            json(
                """
                {
                  "kind": "codex",
                  "label": "Codex",
                  "authModes": ["subscription", "apiKey"],
                  "capabilities": {
                    "events": true,
                    "steer": {"kind": "next-boundary", "note": "next step"},
                    "interrupt": true,
                    "resume": true,
                    "cancel": true,
                    "approval": true
                  },
                  "models": [
                    {"ref": {"agent": "codex", "model": "gpt-5"}, "contextWindow": 400000}
                  ]
                }
                """.trimIndent(),
            ),
        )!!

        assertEquals(AgentKind.Codex, agent.kind)
        assertEquals(listOf(AuthMode.Subscription, AuthMode.ApiKey), agent.authModes)
        assertTrue(agent.capabilities.canSteer)
        assertTrue(agent.capabilities.steer is SteerCapability.NextBoundary)
        assertFalse(agent.capabilities.questions)
        assertFalse(agent.capabilities.subagents)
        assertEquals(400000, agent.models.single().contextWindow)
    }

    @Test
    fun `a missing capabilities object is an explicit refusal, not a permissive default`() {
        val agent = WireCodec.agent(json("""{"kind":"pi","label":"Pi","authModes":[]}"""))!!
        assertFalse(agent.capabilities.events)
        assertFalse(agent.capabilities.canSteer)
        assertTrue(agent.capabilities.steer is SteerCapability.None)
    }

    @Test
    fun `models reported false is a real answer the UI can render`() {
        val models = WireCodec.models(json("""{"agent":"hermes","models":[],"reported":false}"""))
        assertFalse(models.reported)
        assertTrue(models.models.isEmpty())
    }

    @Test
    fun `one unreadable record does not hide healthy siblings`() {
        val missions = WireCodec.parseMissions(
            json("""{"missions":[{"id":"a","title":"A","prompt":"p","status":"running","revision":1},{"nonsense":true},{"id":"b","title":"B","prompt":"p","status":"succeeded","revision":2}]}"""),
        )
        assertEquals(listOf("a", "b"), missions.map { it.id })
    }

    @Test
    fun `mission tree nests children in the order the server sent`() {
        val body = json(
            """
            {"tree": {"mission": {"id":"root","title":"R","prompt":"p","status":"waiting_children","revision":3},
              "children": [
                {"mission": {"id":"c1","title":"C1","prompt":"p","status":"running","revision":1},"children": []},
                {"mission": {"id":"c2","title":"C2","prompt":"p","status":"failed","revision":1},"children": []}
              ]}}
            """.trimIndent(),
        )
        val tree = WireCodec.missionTree(body.objectOrNull("tree"))!!

        assertEquals("root", tree.mission.id)
        assertEquals(listOf("c1", "c2"), tree.children.map { it.mission.id })
        assertEquals(listOf("root", "c1", "c2"), MissionTree.flatten(tree).map { it.node.mission.id })
        assertEquals(listOf(0, 1, 1), MissionTree.flatten(tree).map { it.depth })
    }

    @Test
    fun `history keeps the log sequence and the payload verbatim`() {
        val page = WireCodec.parseHistory(
            json(
                """
                {"events":[
                  {"seq":41,"eventId":"e1","missionId":"m","runId":"r","at":"2026-11-15T10:00:00Z","source":"adapter","type":"run.output","payload":{"text":"hi","stream":"assistant"},"adapterSeq":1}
                ],"nextSeq":41}
                """.trimIndent(),
            ),
        )
        assertEquals(1, page.size)
        assertEquals(41L, page.single().seq)
        assertEquals("assistant", page.single().payload.stringOrNull("stream"))
        assertEquals(1, page.single().adapterSeq)
    }

    @Test
    fun `a command result carries the revision the caller must adopt`() {
        val result = WireCodec.parseCommandResult(
            json(
                """
                {"commandId":"c-1","type":"run.steer","missionId":"m","appliedAt":"2026-11-15T10:00:00Z",
                 "missionRevision":9,"replayed":true,"runId":"r-1","affectedRunIds":["r-1"]}
                """.trimIndent(),
            ),
        )
        assertEquals(9, result.missionRevision)
        assertTrue(result.replayed)
        assertEquals(listOf("r-1"), result.affectedRunIds)
    }

    @Test
    fun `an error envelope keeps the server's code and the revision it holds`() {
        val error = ErrorCodec.parse(
            409,
            json("""{"error":{"code":"revision_conflict","message":"stale","details":{"currentRevision":12,"requestId":"req-1"}}}"""),
        )
        assertEquals(409, error.status)
        assertEquals("revision_conflict", error.details.code)
        assertEquals(12, error.details.currentRevision)
        assertEquals("req-1", error.details.requestId)
        assertTrue(error.isRevisionConflict)
    }

    @Test
    fun `a 401 is unauthenticated and a 403 is a scope refusal`() {
        val unauthorized = ErrorCodec.parse(401, json("""{"error":{"code":"unauthenticated","message":"no"}}"""))
        assertTrue(unauthorized.isUnauthenticated)
        assertFalse(unauthorized.isForbidden)

        val forbidden = ErrorCodec.parse(403, json("""{"error":{"code":"forbidden","message":"scope"}}"""))
        assertFalse(forbidden.isUnauthenticated)
        assertTrue(forbidden.isForbidden)
    }

    @Test
    fun `a bodyless failure still gets a code and a sentence`() {
        val error = ErrorCodec.parse(502, null)
        assertEquals("internal_error", error.details.code)
        assertTrue(error.details.message.isNotEmpty())
    }

    @Test
    fun `pairing response yields the bearer and the session it created`() {
        val pairing = WireCodec.parsePairing(
            json(
                """{"token":"abcdefghijklmnop","session":{"id":"s-1","label":"Pixel","scope":"device","expiresAt":"2026-12-15T10:00:00Z"}}""",
            ),
        )!!
        assertEquals("abcdefghijklmnop", pairing.token)
        assertEquals("Pixel", pairing.label)
        assertEquals("device", pairing.scope)
    }

    @Test
    fun `a pairing response without a token is malformed, not a session`() {
        assertNull(WireCodec.parsePairing(buildJsonObject { put("session", JsonObject(emptyMap())) }))
    }

    @Test
    fun `core url normalisation keeps a scheme and drops a path`() {
        assertEquals("http://192.168.1.4:8789/", CoreUrl.normalize("192.168.1.4:8789")?.toString())
        assertEquals("https://core.example.com/", CoreUrl.normalize("https://core.example.com/foo?x=1#y")?.toString())
        assertEquals("http://127.0.0.1:8789/", CoreUrl.normalize("  http://127.0.0.1:8789  ")?.toString())
        assertNull(CoreUrl.normalize("   "))
    }

    @Test
    fun `terminal ticket path becomes a ws url with the ticket in the query`() {
        val base = CoreUrl.normalize("https://core.example.com")!!
        val url = CoreUrl.webSocketUrl(base, "/api/v1/terminals/t%2F1/stream", "ticket-1")
        assertTrue(url.startsWith("wss://core.example.com/api/v1/terminals/"))
        assertTrue(url.endsWith("?ticket=ticket-1"))
    }
}
