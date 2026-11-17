package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The stored outcome of one command, as `POST /api/v1/missions/...` answers. */
data class CommandResult(
    val commandId: String,
    val type: String,
    val missionId: String,
    val appliedAt: String,
    val missionRevision: Int,
    val replayed: Boolean,
    val runId: String? = null,
    val affectedMissionIds: List<String> = emptyList(),
    val affectedRunIds: List<String> = emptyList(),
)

/**
 * Builds the request every mutation sends.
 *
 * A command id is chosen by the caller so a retry of the same intent is
 * idempotent, and every mutation except `mission.create` names the revision the
 * caller saw so a stale one is refused with `revision_conflict` instead of
 * overwriting newer work (`packages/agent-protocol/commands.ts`,
 * `core/http/routes.ts`).
 */
data class MissionCommandRequest(
    val path: String,
    val body: JsonObject,
)

object MissionCommands {

    fun create(
        title: String,
        prompt: String,
        agent: String,
        environment: JsonObject,
        commandId: String,
        model: JsonObject? = null,
        parentMissionId: String? = null,
    ): MissionCommandRequest = MissionCommandRequest(
        path = "/api/v1/missions",
        body = buildJsonObject {
            put("commandId", commandId)
            put("title", title)
            put("prompt", prompt)
            put("agent", agent)
            put("environment", environment)
            if (model != null) put("model", model)
            if (parentMissionId != null) put("parentMissionId", parentMissionId)
        },
    )

    fun steer(missionId: String, expectedRevision: Int, input: String, commandId: String): MissionCommandRequest =
        revisioned(missionId, "steer", expectedRevision, commandId) { put("input", input) }

    fun submitInput(missionId: String, expectedRevision: Int, input: String, commandId: String): MissionCommandRequest =
        revisioned(missionId, "input", expectedRevision, commandId) { put("input", input) }

    fun interrupt(missionId: String, expectedRevision: Int, commandId: String, reason: String? = null): MissionCommandRequest =
        revisioned(missionId, "interrupt", expectedRevision, commandId) {
            if (reason != null && reason.isNotEmpty()) put("reason", reason)
        }

    fun resume(missionId: String, expectedRevision: Int, commandId: String): MissionCommandRequest =
        revisioned(missionId, "resume", expectedRevision, commandId) {}

    fun cancel(
        missionId: String,
        expectedRevision: Int,
        commandId: String,
        cascade: Boolean? = null,
        reason: String? = null,
    ): MissionCommandRequest = revisioned(missionId, "cancel", expectedRevision, commandId) {
        if (cascade != null) put("cascade", JsonPrimitive(cascade))
        if (reason != null && reason.isNotEmpty()) put("reason", reason)
    }

    fun reconcile(
        missionId: String,
        expectedRevision: Int,
        runId: String,
        action: String,
        commandId: String,
        reason: String? = null,
    ): MissionCommandRequest = revisioned(missionId, "reconcile", expectedRevision, commandId) {
        put("runId", runId)
        put("action", action)
        if (reason != null && reason.isNotEmpty()) put("reason", reason)
    }

    fun resolveApproval(
        missionId: String,
        approvalId: String,
        expectedRevision: Int,
        decision: String,
        commandId: String,
        answer: String? = null,
        by: String? = null,
    ): MissionCommandRequest {
        require(decision == "allow" || decision == "deny" || decision == "answer") {
            "decision must be allow, deny or answer"
        }
        require(decision != "answer" || !answer.isNullOrBlank()) { "an answer decision needs the answer text" }
        return MissionCommandRequest(
            path = "${base(missionId)}/approvals/${encode(approvalId)}/resolve",
            body = buildJsonObject {
                put("commandId", commandId)
                put("expectedRevision", expectedRevision)
                put("decision", decision)
                if (decision == "answer" && answer != null) put("answer", answer)
                if (by != null) put("by", by)
            },
        )
    }

    /** The environment a mission runs on, as the route accepts it: handle
     * fields only, and never a secret-bearing one. */
    fun environmentBody(environment: EnvironmentRef): JsonObject = buildJsonObject {
        put("id", environment.id)
        put("label", environment.label)
        put("kind", environment.kind)
        put("authMode", environment.authMode)
        environment.host?.let { put("host", it) }
        environment.port?.let { put("port", JsonPrimitive(it)) }
        environment.user?.let { put("user", it) }
        environment.credentialRef?.let { put("credentialRef", it) }
        environment.baseUrl?.let { put("baseUrl", it) }
        environment.hostKeyFingerprint?.let { put("hostKeyFingerprint", it) }
    }

    fun modelBody(model: ModelRef): JsonObject = buildJsonObject {
        put("agent", model.agent)
        put("model", model.model)
        model.effort?.let { put("effort", it) }
        model.variant?.let { put("variant", it) }
        model.label?.let { put("label", it) }
    }

    fun historyPath(missionId: String, sinceSeq: Long? = null, limit: Int? = null): String {
        val query = buildList {
            if (sinceSeq != null && sinceSeq > 0) add("since=$sinceSeq")
            if (limit != null) add("limit=$limit")
        }
        return "${base(missionId)}/history" + if (query.isEmpty()) "" else "?${query.joinToString("&")}"
    }

    private fun revisioned(
        missionId: String,
        action: String,
        expectedRevision: Int,
        commandId: String,
        extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
    ): MissionCommandRequest = MissionCommandRequest(
        path = "${base(missionId)}/$action",
        body = buildJsonObject {
            put("commandId", commandId)
            put("expectedRevision", expectedRevision)
            extra()
        },
    )

    private fun base(missionId: String): String = "/api/v1/missions/${encode(missionId)}"

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}

/** A caller-chosen command id. A retry of the same intent reuses it, which is
 * how the authority tells a replay from a second action. */
interface CommandIds {
    fun next(prefix: String): String
}

object UuidCommandIds : CommandIds {
    private var counter = 0

    override fun next(prefix: String): String {
        val random = runCatching { java.util.UUID.randomUUID().toString() }.getOrNull()
        if (random != null) return "$prefix-$random"
        counter += 1
        return "$prefix-${System.currentTimeMillis().toString(36)}-${counter.toString(36)}"
    }
}

/** The statuses a person filters by. Each group names what it holds, so a
 * filter never silently swallows a status it did not list. */
enum class MissionFilter(val label: String) {
    Active("运行中"),
    Waiting("等待中"),
    Finished("已完成"),
    All("全部"),
    ;

    fun matches(status: MissionStatus): Boolean = when (this) {
        Active -> status == MissionStatus.Queued ||
            status == MissionStatus.Provisioning ||
            status == MissionStatus.Running ||
            status == MissionStatus.Resuming
        Waiting -> status == MissionStatus.WaitingInput ||
            status == MissionStatus.WaitingChildren ||
            status == MissionStatus.Interrupted
        Finished -> status.isTerminal
        All -> true
    }
}

/** One row of a mission tree in reading order, so a screen reader and a
 * sighted reader walk the same sequence. */
data class TreeRow(val node: MissionTreeNode, val depth: Int)

object MissionTree {
    fun flatten(root: MissionTreeNode): List<TreeRow> {
        val rows = mutableListOf<TreeRow>()
        fun walk(node: MissionTreeNode, depth: Int) {
            rows += TreeRow(node, depth)
            node.children.forEach { walk(it, depth + 1) }
        }
        walk(root, 0)
        return rows
    }
}

/** Which operations a mission's own status allows. The server enforces the same
 * table; offering a button it would refuse only teaches a person to distrust
 * the buttons that work. */
data class AllowedOperations(
    val steer: Boolean,
    val interrupt: Boolean,
    val resume: Boolean,
    val cancel: Boolean,
    val answer: Boolean,
)

fun allowedOperations(mission: Mission): AllowedOperations {
    val terminal = mission.status.isTerminal
    return AllowedOperations(
        steer = !terminal && (mission.status == MissionStatus.Running || mission.status == MissionStatus.WaitingChildren),
        interrupt = !terminal && (
            mission.status == MissionStatus.Running ||
                mission.status == MissionStatus.WaitingInput ||
                mission.status == MissionStatus.WaitingChildren
            ),
        resume = mission.status == MissionStatus.Interrupted,
        cancel = !terminal,
        answer = mission.status == MissionStatus.WaitingInput,
    )
}

/** Child counts a parent's row shows at a glance. */
data class ChildSummary(
    val total: Int,
    val running: Int,
    val waiting: Int,
    val succeeded: Int,
    val failed: Int,
    val cancelled: Int,
)

fun summarizeChildren(root: MissionTreeNode): ChildSummary {
    var total = 0
    var running = 0
    var waiting = 0
    var succeeded = 0
    var failed = 0
    var cancelled = 0
    MissionTree.flatten(root).drop(1).forEach { row ->
        total += 1
        when (row.node.mission.status) {
            MissionStatus.WaitingInput, MissionStatus.WaitingChildren -> waiting += 1
            MissionStatus.Succeeded -> succeeded += 1
            MissionStatus.Failed -> failed += 1
            MissionStatus.Cancelled -> cancelled += 1
            else -> running += 1
        }
    }
    return ChildSummary(total, running, waiting, succeeded, failed, cancelled)
}
