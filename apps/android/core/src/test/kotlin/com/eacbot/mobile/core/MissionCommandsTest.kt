package com.eacbot.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MissionCommandsTest {

    private fun body(request: MissionCommandRequest): String = request.body.toString()

    @Test
    fun `create names the command id and no revision`() {
        val request = MissionCommands.create(
            title = "Sort the inbox",
            prompt = "Sort it",
            agent = "hermes",
            environment = MissionCommands.environmentBody(
                EnvironmentRef(id = "env-1", label = "Laptop", kind = "local", authMode = "local"),
            ),
            commandId = "c-1",
        )
        assertEquals("/api/v1/missions", request.path)
        val text = body(request)
        assertTrue(text.contains("\"commandId\":\"c-1\""))
        assertTrue(text.contains("\"agent\":\"hermes\""))
        assertTrue(!text.contains("expectedRevision"))
    }

    @Test
    fun `every mutation but create carries the revision the caller saw`() {
        val requests = listOf(
            MissionCommands.steer("m-1", 4, "go left", "c-1"),
            MissionCommands.submitInput("m-1", 4, "yes", "c-2"),
            MissionCommands.interrupt("m-1", 4, "c-3"),
            MissionCommands.resume("m-1", 4, "c-4"),
            MissionCommands.cancel("m-1", 4, "c-5"),
            MissionCommands.reconcile("m-1", 4, "r-1", "cancel", "c-6"),
            MissionCommands.resolveApproval("m-1", "a-1", 4, "allow", "c-7"),
        )
        requests.forEach { request ->
            assertTrue(request.body.toString().contains("\"expectedRevision\":4"))
        }
    }

    @Test
    fun `a mission id is encoded into the path exactly once`() {
        val request = MissionCommands.steer("m/with space", 1, "x", "c-1")
        assertEquals("/api/v1/missions/m%2Fwith%20space/steer", request.path)
    }

    @Test
    fun `an approval resolve encodes the approval id`() {
        val request = MissionCommands.resolveApproval("m-1", "a/9", 2, "deny", "c-1")
        assertEquals("/api/v1/missions/m-1/approvals/a%2F9/resolve", request.path)
        assertTrue(request.body.toString().contains("\"decision\":\"deny\""))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `an answer decision without text is refused before it is sent`() {
        MissionCommands.resolveApproval("m-1", "a-1", 2, "answer", "c-1", answer = "  ")
    }

    @Test
    fun `an answer decision sends the answer text`() {
        val request = MissionCommands.resolveApproval("m-1", "a-1", 2, "answer", "c-1", answer = "use the archive")
        assertTrue(request.body.toString().contains("\"answer\":\"use the archive\""))
    }

    @Test
    fun `an empty optional reason is omitted rather than sent as an empty string`() {
        val request = MissionCommands.interrupt("m-1", 1, "c-1", reason = "")
        assertTrue(!request.body.toString().contains("reason"))
    }

    @Test
    fun `cancel can ask for a cascade and say why`() {
        val request = MissionCommands.cancel("m-1", 3, "c-1", cascade = true, reason = "wrong direction")
        val text = request.body.toString()
        assertTrue(text.contains("\"cascade\":true"))
        assertTrue(text.contains("\"reason\":\"wrong direction\""))
    }

    @Test
    fun `history path omits a zero cursor and adds a limit`() {
        assertEquals("/api/v1/missions/m-1/history", MissionCommands.historyPath("m-1"))
        assertEquals("/api/v1/missions/m-1/history", MissionCommands.historyPath("m-1", 0))
        assertEquals("/api/v1/missions/m-1/history?since=42", MissionCommands.historyPath("m-1", 42))
        assertEquals("/api/v1/missions/m-1/history?since=42&limit=50", MissionCommands.historyPath("m-1", 42, 50))
    }

    @Test
    fun `environment body never carries a secret field`() {
        val body = MissionCommands.environmentBody(
            EnvironmentRef(
                id = "env-1",
                label = "Build box",
                kind = "ssh",
                host = "10.0.0.4",
                port = 22,
                user = "dev",
                authMode = "subscription",
                credentialRef = "cred-1",
            ),
        )
        val text = body.toString()
        assertTrue(text.contains("\"credentialRef\":\"cred-1\""))
        listOf("privateKey", "password", "passphrase", "apiKey", "token").forEach {
            assertTrue("must not send $it", !text.contains(it))
        }
    }

    @Test
    fun `operations follow the status the authority enforces`() {
        fun mission(status: MissionStatus) = Mission(
            id = "m",
            rootMissionId = "m",
            parentMissionId = null,
            depth = 0,
            title = "t",
            prompt = "p",
            agent = AgentKind.Hermes,
            rawAgent = "hermes",
            model = null,
            environment = null,
            status = status,
            revision = 1,
            createdAt = "",
            updatedAt = "",
            acceptedAt = "",
        )

        assertTrue(allowedOperations(mission(MissionStatus.Running)).steer)
        assertTrue(allowedOperations(mission(MissionStatus.WaitingInput)).answer)
        assertTrue(!allowedOperations(mission(MissionStatus.WaitingInput)).steer)
        assertTrue(allowedOperations(mission(MissionStatus.Interrupted)).resume)
        assertTrue(!allowedOperations(mission(MissionStatus.Succeeded)).cancel)
        assertTrue(!allowedOperations(mission(MissionStatus.Cancelled)).interrupt)
    }

    @Test
    fun `filters name every status they hold`() {
        MissionStatus.entries.forEach { status ->
            val matched = MissionFilter.entries.filter { it.matches(status) }
            assertTrue("$status must match at least one filter", matched.isNotEmpty())
            assertTrue("All must match $status", MissionFilter.All.matches(status))
        }
        assertTrue(MissionFilter.Active.matches(MissionStatus.Running))
        assertTrue(!MissionFilter.Active.matches(MissionStatus.WaitingInput))
        assertTrue(MissionFilter.Waiting.matches(MissionStatus.WaitingChildren))
        assertTrue(MissionFilter.Finished.matches(MissionStatus.Failed))
        assertTrue(!MissionFilter.Finished.matches(MissionStatus.Running))
    }

    @Test
    fun `child summary counts every status once`() {
        fun node(id: String, status: MissionStatus, children: List<MissionTreeNode> = emptyList()) = MissionTreeNode(
            Mission(
                id = id,
                rootMissionId = "root",
                parentMissionId = null,
                depth = 0,
                title = id,
                prompt = "",
                agent = AgentKind.Hermes,
                rawAgent = "hermes",
                model = null,
                environment = null,
                status = status,
                revision = 1,
                createdAt = "",
                updatedAt = "",
                acceptedAt = "",
            ),
            children,
        )

        val root = node(
            "root",
            MissionStatus.WaitingChildren,
            listOf(
                node("a", MissionStatus.Running),
                node("b", MissionStatus.WaitingInput),
                node("c", MissionStatus.Succeeded),
                node("d", MissionStatus.Failed, listOf(node("d1", MissionStatus.Cancelled))),
            ),
        )
        val summary = summarizeChildren(root)
        assertEquals(5, summary.total)
        assertEquals(1, summary.running)
        assertEquals(1, summary.waiting)
        assertEquals(1, summary.succeeded)
        assertEquals(1, summary.failed)
        assertEquals(1, summary.cancelled)
    }

    @Test
    fun `a command id is unique per attempt and keeps its prefix`() {
        val ids = UuidCommandIds
        val first = ids.next("steer")
        val second = ids.next("steer")
        assertTrue(first.startsWith("steer-"))
        assertTrue(first != second)
    }

    @Test
    fun `a generated id survives a retry of the same intent`() {
        val id = UuidCommandIds.next("cancel")
        val first = MissionCommands.cancel("m", 1, id)
        val retry = MissionCommands.cancel("m", 1, id)
        assertEquals(first.body.toString(), retry.body.toString())
    }

    @Test
    fun `model body carries the engine's own identifier`() {
        val body = MissionCommands.modelBody(ModelRef(agent = "codex", model = "gpt-5", effort = "high"))
        val text = body.toString()
        assertTrue(text.contains("\"model\":\"gpt-5\""))
        assertTrue(text.contains("\"effort\":\"high\""))
        assertNull(null)
    }
}
