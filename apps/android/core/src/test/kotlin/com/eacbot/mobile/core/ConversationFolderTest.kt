package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationFolderTest {

    private fun entry(
        seq: Long,
        type: String,
        runId: String? = "r-1",
        adapterSeq: Int? = null,
        payload: String = "{}",
    ): MissionLogEntry = MissionLogEntry(
        seq = seq,
        eventId = "e-$seq",
        missionId = "m-1",
        runId = runId,
        at = "2026-11-15T10:00:00Z",
        source = if (type.startsWith("run.")) "adapter" else "authority",
        type = type,
        payload = wireJson.parseToJsonElement(payload) as JsonObject,
        adapterSeq = adapterSeq,
    )

    @Test
    fun `assistant output accumulates into one item per run`() {
        var fold = ConversationFolder.empty()
        fold = ConversationFolder.fold(
            fold,
            listOf(
                entry(1, "run.output", adapterSeq = 1, payload = """{"text":"Hel","stream":"assistant"}"""),
                entry(2, "run.output", adapterSeq = 2, payload = """{"text":"lo","stream":"assistant"}"""),
            ),
        )
        assertEquals("Hello", fold.assistantText)
        assertEquals(1, fold.items.filterIsInstance<ConversationItem.AssistantText>().size)
        assertEquals("Hello", fold.items.filterIsInstance<ConversationItem.AssistantText>().single().text)
        assertEquals(2L, fold.nextSeq)
    }

    @Test
    fun `stderr is a separate line, not folded into the answer`() {
        var fold = ConversationFolder.empty()
        fold = ConversationFolder.fold(
            fold,
            listOf(
                entry(1, "run.output", adapterSeq = 1, payload = """{"text":"answer","stream":"assistant"}"""),
                entry(2, "run.output", adapterSeq = 2, payload = """{"text":"warning","stream":"stderr"}"""),
            ),
        )
        assertEquals("answer", fold.assistantText)
        assertEquals(1, fold.items.filterIsInstance<ConversationItem.StreamText>().size)
    }

    @Test
    fun `a tool call and its result become one card`() {
        var fold = ConversationFolder.empty()
        fold = ConversationFolder.fold(
            fold,
            listOf(
                entry(1, "run.tool_call", adapterSeq = 1, payload = """{"callId":"c1","tool":"read_file","input":{"path":"/tmp/a"}}"""),
            ),
        )
        val pending = fold.toolCards.single()
        assertNull(pending.ok)
        assertNull(pending.output)
        assertTrue(pending.input.contains("/tmp/a"))

        fold = ConversationFolder.fold(
            fold,
            listOf(
                entry(2, "run.tool_result", adapterSeq = 2, payload = """{"callId":"c1","tool":"read_file","ok":true,"output":"contents"}"""),
            ),
        )
        val done = fold.toolCards.single()
        assertEquals(true, done.ok)
        assertEquals("contents", done.output)
    }

    @Test
    fun `a tool result without its call still appears`() {
        val fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(entry(5, "run.tool_result", adapterSeq = 1, payload = """{"callId":"c9","tool":"shell","ok":false}""")),
        )
        assertEquals(1, fold.toolCards.size)
        assertEquals("c9", fold.toolCards.single().callId)
        assertEquals(false, fold.toolCards.single().ok)
    }

    @Test
    fun `an approval request is pending until it is resolved`() {
        var fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(
                entry(
                    1,
                    "run.approval_requested",
                    adapterSeq = 1,
                    payload = """{"approvalId":"a1","action":"write file","detail":"/etc/hosts"}""",
                ),
            ),
        )
        assertEquals(1, fold.pendingApprovals.size)
        assertTrue(fold.pendingApprovals.single().isPending)

        fold = ConversationFolder.fold(
            fold,
            listOf(entry(2, "run.approval_resolved", adapterSeq = 2, payload = """{"approvalId":"a1","decision":"deny","by":"phone"}""")),
        )
        assertTrue(fold.pendingApprovals.isEmpty())
        val card = fold.items.filterIsInstance<ConversationItem.ApprovalCard>().single()
        assertEquals("deny", card.decision)
        assertEquals("phone", card.decidedBy)
    }

    @Test
    fun `a question is pending until input arrives`() {
        var fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(entry(1, "run.waiting_input", adapterSeq = 1, payload = """{"question":"Which folder?"}""")),
        )
        assertEquals(1, fold.pendingQuestions.size)

        fold = ConversationFolder.fold(
            fold,
            listOf(entry(2, "run.input_received", adapterSeq = 2, payload = """{"input":"/srv/data"}""")),
        )
        assertTrue(fold.pendingQuestions.isEmpty())
        assertEquals("/srv/data", fold.items.filterIsInstance<ConversationItem.QuestionCard>().single().answer)
    }

    @Test
    fun `a duplicate adapter sequence is not drawn twice`() {
        var fold = ConversationFolder.empty()
        fold = ConversationFolder.fold(
            fold,
            listOf(entry(1, "run.output", adapterSeq = 1, payload = """{"text":"once","stream":"assistant"}""")),
        )
        fold = ConversationFolder.fold(
            fold,
            listOf(entry(2, "run.output", adapterSeq = 1, payload = """{"text":"once","stream":"assistant"}""")),
        )
        assertEquals("once", fold.assistantText)
    }

    @Test
    fun `a seq gap is recorded so the view refetches instead of pretending continuity`() {
        var fold = ConversationFolder.empty()
        fold = ConversationFolder.fold(
            fold,
            listOf(entry(1, "run.output", adapterSeq = 1, payload = """{"text":"a","stream":"assistant"}""")),
        )
        assertEquals(1L, fold.nextSeq)

        fold = ConversationFolder.fold(
            fold,
            listOf(entry(10, "run.output", adapterSeq = 2, payload = """{"text":"z","stream":"assistant"}""")),
        )
        assertNotNull("a jump from 1 to 10 is a gap", fold.gapAt)
        assertEquals(2L, fold.gapAt)
    }

    @Test
    fun `contiguous pages do not report a gap`() {
        var fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(entry(1, "run.output", adapterSeq = 1, payload = """{"text":"a","stream":"assistant"}""")),
        )
        fold = ConversationFolder.fold(
            fold,
            listOf(entry(2, "run.output", adapterSeq = 2, payload = """{"text":"b","stream":"assistant"}""")),
        )
        assertNull(fold.gapAt)
        assertEquals("ab", fold.assistantText)
    }

    @Test
    fun `a resync rebuilds the fold from a snapshot and clears the gap`() {
        val items = listOf(
            ConversationItem.AssistantText(3, "fresh", "r-1"),
            ConversationItem.RunMarker(4, "completed", null, "r-1"),
        )
        val fold = ConversationFolder.resynced(items, nextSeq = 4)
        assertEquals(2, fold.items.size)
        assertEquals("fresh", fold.assistantText)
        assertNull(fold.gapAt)
        assertEquals(4L, fold.nextSeq)
    }

    @Test
    fun `run markers carry their outcome detail`() {
        val fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(
                entry(1, "run.started", adapterSeq = 1, payload = """{"model":"hermes-4"}"""),
                entry(2, "run.failed", adapterSeq = 2, payload = """{"code":"native_start_failed","message":"no engine"}"""),
            ),
        )
        val markers = fold.items.filterIsInstance<ConversationItem.RunMarker>()
        assertEquals(listOf("started", "failed"), markers.map { it.kind })
        assertEquals("no engine", markers.last().detail)
    }

    @Test
    fun `usage and artifacts are their own items`() {
        val fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(
                entry(1, "run.usage", adapterSeq = 1, payload = """{"inputTokens":100,"outputTokens":20,"costUsd":0.02}"""),
                entry(
                    2,
                    "run.artifact",
                    adapterSeq = 2,
                    payload = """{"artifactId":"art-1","path":"/tmp/report.pdf","bytes":2048,"mediaType":"application/pdf"}""",
                ),
            ),
        )
        val usage = fold.items.filterIsInstance<ConversationItem.UsageLine>().single()
        assertEquals(100, usage.inputTokens)
        assertEquals(0.02, usage.costUsd!!, 0.0001)
        assertEquals("/tmp/report.pdf", fold.items.filterIsInstance<ConversationItem.ArtifactCard>().single().path)
    }

    @Test
    fun `an empty page leaves the fold untouched`() {
        val previous = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(entry(1, "run.output", adapterSeq = 1, payload = """{"text":"a","stream":"assistant"}""")),
        )
        val next = ConversationFolder.fold(previous, emptyList())
        assertEquals(previous, next)
    }

    @Test
    fun `items stay ordered by the log sequence across pages`() {
        var fold = ConversationFolder.fold(
            ConversationFolder.empty(),
            listOf(
                entry(1, "run.started", adapterSeq = 1),
                entry(2, "run.output", adapterSeq = 2, payload = """{"text":"hi","stream":"assistant"}"""),
            ),
        )
        fold = ConversationFolder.fold(
            fold,
            listOf(entry(3, "run.completed", adapterSeq = 3)),
        )
        assertEquals(listOf(1L, 2L, 3L), fold.items.map { it.seq })
    }
}
