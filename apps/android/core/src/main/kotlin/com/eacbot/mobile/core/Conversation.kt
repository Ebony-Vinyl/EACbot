package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject

/**
 * One item in a conversation, folded from the mission log.
 *
 * The log is the only source: a tool card is a `run.tool_call` paired with its
 * `run.tool_result`, an approval is a `run.approval_requested` and its
 * resolution, and assistant text is the concatenation of `run.output` events
 * with `stream = "assistant"`. Nothing is inferred that the log did not record.
 */
sealed interface ConversationItem {
    val seq: Long

    data class AssistantText(
        override val seq: Long,
        val text: String,
        val runId: String?,
    ) : ConversationItem

    data class StreamText(
        override val seq: Long,
        val text: String,
        val stream: String,
        val runId: String?,
    ) : ConversationItem

    data class ToolCard(
        override val seq: Long,
        val callId: String,
        val tool: String,
        val input: String,
        val output: String?,
        val ok: Boolean?,
        val runId: String?,
    ) : ConversationItem

    data class ApprovalCard(
        override val seq: Long,
        val approvalId: String,
        val action: String,
        val detail: String,
        val expiresAt: String?,
        val decision: String?,
        val decidedBy: String?,
        val runId: String?,
    ) : ConversationItem {
        val isPending: Boolean get() = decision == null
    }

    data class QuestionCard(
        override val seq: Long,
        val question: String,
        val answer: String?,
        val runId: String?,
    ) : ConversationItem {
        val isPending: Boolean get() = answer == null
    }

    data class RunMarker(
        override val seq: Long,
        val kind: String,
        val detail: String?,
        val runId: String?,
    ) : ConversationItem

    data class ArtifactCard(
        override val seq: Long,
        val artifactId: String,
        val path: String,
        val mediaType: String,
        val bytes: Long,
        val runId: String?,
    ) : ConversationItem

    data class UsageLine(
        override val seq: Long,
        val inputTokens: Int?,
        val outputTokens: Int?,
        val costUsd: Double?,
        val runId: String?,
    ) : ConversationItem
}

/** What a fold produced, plus the two facts a screen must not lose: the cursor
 * to ask from next and whether the log had a gap. */
data class ConversationFold(
    val items: List<ConversationItem> = emptyList(),
    val nextSeq: Long = 0L,
    /** Adapter sequences already folded, per run, so a duplicate event is
     * dropped instead of drawn twice. */
    val adapterSeqs: Map<String, Set<Int>> = emptyMap(),
    /** A `seq` gap in the log: entries were missed, so the view must resync. */
    val gapAt: Long? = null,
    val assistantText: String = "",
    val toolCards: List<ConversationItem.ToolCard> = emptyList(),
    val pendingApprovals: List<ConversationItem.ApprovalCard> = emptyList(),
    val pendingQuestions: List<ConversationItem.QuestionCard> = emptyList(),
)

/**
 * Folds mission-log pages into conversation items.
 *
 * `seq` is the log's own monotonic sequence. A page whose first entry is not
 * exactly `nextSeq` means the client missed something: the fold records
 * [ConversationFold.gapAt] rather than pretending the page is contiguous, and
 * the caller refetches a snapshot.
 */
object ConversationFolder {

    fun empty(nextSeq: Long = 0L): ConversationFold = ConversationFold(nextSeq = nextSeq)

    fun fold(
        previous: ConversationFold,
        page: List<MissionLogEntry>,
        expectContiguous: Boolean = true,
    ): ConversationFold {
        if (page.isEmpty()) return previous
        val first = page.first().seq
        val gap = when {
            !expectContiguous -> null
            previous.nextSeq == 0L -> null
            first > previous.nextSeq + 1 -> previous.nextSeq + 1
            first < previous.nextSeq + 1 -> null
            else -> null
        }
        val accepted = page.filter { it.seq >= previous.nextSeq || previous.nextSeq == 0L }
        if (accepted.isEmpty()) return previous

        val items = previous.items.toMutableList()
        val adapterSeqs = previous.adapterSeqs.toMutableMap()
        val assistant = StringBuilder(previous.assistantText)

        for (entry in accepted) {
            if (entry.adapterSeq != null && entry.runId != null) {
                val seen = adapterSeqs.getOrPut(entry.runId) { emptySet() }
                if (entry.adapterSeq in seen) continue
                adapterSeqs[entry.runId] = seen + entry.adapterSeq
            }
            apply(entry, items, assistant)
        }

        val sorted = items.sortedBy { it.seq }
        return ConversationFold(
            items = sorted,
            nextSeq = maxOf(previous.nextSeq, accepted.maxOf { it.seq }),
            adapterSeqs = adapterSeqs,
            gapAt = gap ?: previous.gapAt,
            assistantText = assistant.toString(),
            toolCards = sorted.filterIsInstance<ConversationItem.ToolCard>(),
            pendingApprovals = sorted.filterIsInstance<ConversationItem.ApprovalCard>().filter { it.isPending },
            pendingQuestions = sorted.filterIsInstance<ConversationItem.QuestionCard>().filter { it.isPending },
        )
    }

    /** A resync: the client's cursor was too old, so the view is rebuilt from a
     * fresh snapshot instead of patched. */
    fun resynced(items: List<ConversationItem>, nextSeq: Long): ConversationFold {
        val sorted = items.sortedBy { it.seq }
        return ConversationFold(
            items = sorted,
            nextSeq = nextSeq,
            gapAt = null,
            assistantText = sorted.filterIsInstance<ConversationItem.AssistantText>().joinToString("") { it.text },
            toolCards = sorted.filterIsInstance<ConversationItem.ToolCard>(),
            pendingApprovals = sorted.filterIsInstance<ConversationItem.ApprovalCard>().filter { it.isPending },
            pendingQuestions = sorted.filterIsInstance<ConversationItem.QuestionCard>().filter { it.isPending },
        )
    }

    private fun apply(
        entry: MissionLogEntry,
        items: MutableList<ConversationItem>,
        assistant: StringBuilder,
    ) {
        val payload = entry.payload
        val runId = entry.runId
        when (entry.type) {
            "run.output" -> {
                val text = payload.stringOrNull("text") ?: return
                val stream = payload.stringOrNull("stream") ?: "assistant"
                if (stream == "assistant") {
                    assistant.append(text)
                    val last = items.lastOrNull()
                    if (last is ConversationItem.AssistantText && last.runId == runId) {
                        items[items.lastIndex] = last.copy(seq = entry.seq, text = last.text + text)
                    } else {
                        items += ConversationItem.AssistantText(entry.seq, text, runId)
                    }
                } else {
                    items += ConversationItem.StreamText(entry.seq, text, stream, runId)
                }
            }
            "run.tool_call" -> {
                val callId = payload.stringOrNull("callId") ?: return
                items += ConversationItem.ToolCard(
                    seq = entry.seq,
                    callId = callId,
                    tool = payload.stringOrNull("tool") ?: "tool",
                    input = renderInput(payload["input"]),
                    output = null,
                    ok = null,
                    runId = runId,
                )
            }
            "run.tool_result" -> {
                val callId = payload.stringOrNull("callId") ?: return
                val index = items.indexOfLast { it is ConversationItem.ToolCard && it.callId == callId }
                val output = payload.stringOrNull("output")
                val ok = payload.booleanOrNull("ok")
                if (index >= 0) {
                    val card = items[index] as ConversationItem.ToolCard
                    items[index] = card.copy(output = output, ok = ok)
                } else {
                    // A result whose call was never seen still belongs in the
                    // transcript; hiding it would misreport what ran.
                    items += ConversationItem.ToolCard(
                        seq = entry.seq,
                        callId = callId,
                        tool = payload.stringOrNull("tool") ?: "tool",
                        input = "",
                        output = output,
                        ok = ok,
                        runId = runId,
                    )
                }
            }
            "run.approval_requested" -> {
                val approvalId = payload.stringOrNull("approvalId") ?: return
                items += ConversationItem.ApprovalCard(
                    seq = entry.seq,
                    approvalId = approvalId,
                    action = payload.stringOrNull("action") ?: "",
                    detail = payload.stringOrNull("detail") ?: "",
                    expiresAt = payload.stringOrNull("expiresAt"),
                    decision = null,
                    decidedBy = null,
                    runId = runId,
                )
            }
            "run.approval_resolved" -> {
                val approvalId = payload.stringOrNull("approvalId") ?: return
                val index = items.indexOfLast { it is ConversationItem.ApprovalCard && it.approvalId == approvalId }
                val decision = payload.stringOrNull("decision")
                val by = payload.stringOrNull("by")
                if (index >= 0) {
                    val card = items[index] as ConversationItem.ApprovalCard
                    items[index] = card.copy(decision = decision, decidedBy = by)
                } else {
                    items += ConversationItem.ApprovalCard(
                        seq = entry.seq,
                        approvalId = approvalId,
                        action = payload.stringOrNull("action") ?: "",
                        detail = payload.stringOrNull("detail") ?: "",
                        expiresAt = null,
                        decision = decision,
                        decidedBy = by,
                        runId = runId,
                    )
                }
            }
            "run.waiting_input" -> {
                items += ConversationItem.QuestionCard(
                    seq = entry.seq,
                    question = payload.stringOrNull("question") ?: "",
                    answer = null,
                    runId = runId,
                )
            }
            "run.input_received" -> {
                val input = payload.stringOrNull("input") ?: ""
                val index = items.indexOfLast { it is ConversationItem.QuestionCard && it.answer == null }
                if (index >= 0) {
                    val card = items[index] as ConversationItem.QuestionCard
                    items[index] = card.copy(answer = input)
                }
            }
            "run.started" -> items += ConversationItem.RunMarker(entry.seq, "started", payload.stringOrNull("model"), runId)
            "run.completed" -> items += ConversationItem.RunMarker(entry.seq, "completed", payload.stringOrNull("summary"), runId)
            "run.failed" -> items += ConversationItem.RunMarker(entry.seq, "failed", payload.stringOrNull("message"), runId)
            "run.cancelled" -> items += ConversationItem.RunMarker(entry.seq, "cancelled", payload.stringOrNull("reason"), runId)
            "run.interrupted" -> items += ConversationItem.RunMarker(entry.seq, "interrupted", payload.stringOrNull("reason"), runId)
            "run.resumed" -> items += ConversationItem.RunMarker(entry.seq, "resumed", null, runId)
            "run.artifact" -> {
                val artifactId = payload.stringOrNull("artifactId") ?: return
                items += ConversationItem.ArtifactCard(
                    seq = entry.seq,
                    artifactId = artifactId,
                    path = payload.stringOrNull("path") ?: "",
                    mediaType = payload.stringOrNull("mediaType") ?: "application/octet-stream",
                    bytes = payload.longOrNull("bytes") ?: 0L,
                    runId = runId,
                )
            }
            "run.usage" -> items += ConversationItem.UsageLine(
                seq = entry.seq,
                inputTokens = payload.intOrNull("inputTokens"),
                outputTokens = payload.intOrNull("outputTokens"),
                costUsd = (payload["costUsd"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull(),
                runId = runId,
            )
            else -> Unit
        }
    }

    private fun renderInput(element: kotlinx.serialization.json.JsonElement?): String = when (element) {
        null -> ""
        is kotlinx.serialization.json.JsonPrimitive -> element.content
        else -> element.toString()
    }
}

/**
 * When a notification is worth showing, and what it may say.
 *
 * Two transitions only: an agent started waiting for the person, and an agent
 * finished without waiting. The body is a fixed phrase plus the mission title,
 * so a lock screen never shows prompt text, tool input or an approval detail
 * (`docs/design/grokbot-ui-notes.md`, "通知").
 */
data class NotificationDecision(
    val kind: NotificationKind,
    val title: String,
    val body: String,
    val missionId: String?,
    val runId: String?,
) {
    enum class NotificationKind { NeedsYou, Finished }
}

object NotificationPolicy {

    /** Fold one notification against the mission snapshot the app holds.
     *
     * `previous` is the status the app last showed for that mission; a
     * transition is what earns a notification, not a state that happens to be
     * true when the app reconnects. `recentlyNotified` holds `<mission>:<kind>`
     * keys already shown inside the throttle window. */
    fun decide(
        missionId: String?,
        missionTitle: String?,
        previous: MissionStatus?,
        current: MissionStatus?,
        runId: String?,
        appInForeground: Boolean,
        recentlyNotified: Set<String>,
        throttleKey: (String) -> String = { it },
    ): NotificationDecision? {
        if (missionId == null || current == null) return null
        // An active device is already showing the change.
        if (appInForeground) return null
        if (previous == current) return null

        val needsYou = current == MissionStatus.WaitingInput
        val finished = current.isTerminal && current != MissionStatus.Cancelled
        if (!needsYou && !finished) return null
        if (needsYou && previous == MissionStatus.WaitingInput) return null
        if (finished && previous?.isTerminal == true) return null

        val kind = if (needsYou) NotificationDecision.NotificationKind.NeedsYou else NotificationDecision.NotificationKind.Finished
        val key = throttleKey("$missionId:$kind")
        if (key in recentlyNotified) return null

        val safeTitle = missionTitle?.take(80)?.ifBlank { null } ?: "Hermes"
        return NotificationDecision(
            kind = kind,
            title = safeTitle,
            body = when (kind) {
                NotificationDecision.NotificationKind.NeedsYou -> "Waiting for your answer"
                NotificationDecision.NotificationKind.Finished -> when (current) {
                    MissionStatus.Succeeded -> "Finished"
                    MissionStatus.Failed -> "Stopped with an error"
                    else -> "Finished"
                }
            },
            missionId = missionId,
            runId = runId,
        )
    }
}
