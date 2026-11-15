package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject

/**
 * The wire types a phone reads, mirroring `packages/agent-protocol`.
 *
 * Every shape here is parsed by hand from a [kotlinx.serialization.json.JsonObject]
 * rather than by generated serializers: the protocol treats an unknown field as
 * additive and a missing one as absent, and a required field this client does
 * not know how to read must degrade one record instead of failing a whole
 * response.
 */

const val PROTOCOL_VERSION = 1

/** Engine identities the core may name. An unknown engine stays a string so a
 * newer core still renders, but it is not offered as a choice. */
enum class AgentKind(val wire: String) {
    Hermes("hermes"),
    ClaudeCode("claudeCode"),
    Codex("codex"),
    OpenCode("openCode"),
    Pi("pi"),
    OhMyPi("ohMyPi"),
    Custom("custom"),
    ;

    companion object {
        fun fromWire(value: String?): AgentKind? = entries.firstOrNull { it.wire == value }
    }
}

enum class AuthMode(val wire: String) {
    Subscription("subscription"),
    ApiKey("apiKey"),
    CompatibleEndpoint("compatibleEndpoint"),
    Local("local"),
    ;

    companion object {
        fun fromWire(value: String?): AuthMode? = entries.firstOrNull { it.wire == value }
    }
}

enum class MissionStatus(val wire: String) {
    Queued("queued"),
    Provisioning("provisioning"),
    Running("running"),
    WaitingInput("waiting_input"),
    WaitingChildren("waiting_children"),
    Interrupted("interrupted"),
    Resuming("resuming"),
    Succeeded("succeeded"),
    Failed("failed"),
    Cancelled("cancelled"),
    ;

    val isTerminal: Boolean
        get() = this == Succeeded || this == Failed || this == Cancelled

    companion object {
        fun fromWire(value: String?): MissionStatus? = entries.firstOrNull { it.wire == value }
    }
}

enum class TerminalKind(val wire: String) {
    NativeTui("nativeTui"),
    Pty("pty"),
    Exec("exec"),
    ;

    companion object {
        fun fromWire(value: String?): TerminalKind? = entries.firstOrNull { it.wire == value }
    }
}

/** How an engine takes a message into a turn already running. */
sealed interface SteerCapability {
    data object Native : SteerCapability

    data class NextBoundary(val note: String) : SteerCapability

    data class None(val reason: String) : SteerCapability
}

data class AgentCapabilities(
    val events: Boolean,
    val steer: SteerCapability,
    val interrupt: Boolean,
    val resume: Boolean,
    val cancel: Boolean,
    val approval: Boolean,
    val questions: Boolean,
    val nativeTui: Boolean,
    val modelCatalog: Boolean,
    val subagents: Boolean,
    val images: Boolean,
    val usage: Boolean,
    val fileChanges: Boolean,
) {
    /** Whether the engine accepts mid-turn input at all, whatever its mode. */
    val canSteer: Boolean get() = steer !is SteerCapability.None

    companion object {
        /** Nothing is assumed: an engine that has not reported a capability is
         * shown as unable to do it, which is also what the authority enforces. */
        val NONE = AgentCapabilities(
            events = false,
            steer = SteerCapability.None("the engine has not reported steering"),
            interrupt = false,
            resume = false,
            cancel = false,
            approval = false,
            questions = false,
            nativeTui = false,
            modelCatalog = false,
            subagents = false,
            images = false,
            usage = false,
            fileChanges = false,
        )
    }
}

/** A concrete model an agent can run. `model` is the adapter's own identifier. */
data class ModelRef(
    val agent: String,
    val model: String,
    val effort: String? = null,
    val variant: String? = null,
    val label: String? = null,
) {
    /** What a list row shows when the engine supplied no display label. */
    val display: String get() = label ?: model
}

data class ModelCatalogEntry(
    val ref: ModelRef,
    val contextWindow: Int? = null,
    val maxOutputTokens: Int? = null,
    val supportsImages: Boolean? = null,
    val defaultEffort: String? = null,
    val efforts: List<String> = emptyList(),
)

data class AgentDescriptor(
    val kind: AgentKind?,
    /** The engine's own name as the core sent it, even when this client does not
     * know the enum value. */
    val rawKind: String,
    val label: String,
    val authModes: List<AuthMode>,
    val capabilities: AgentCapabilities,
    val models: List<ModelCatalogEntry>,
)

/** `GET /api/v1/agents/:kind/models`. `reported = false` is a real answer: the
 * engine has no catalog surface, so the UI must say "unknown" rather than
 * invent a model list. */
data class AgentModels(
    val agent: String,
    val models: List<ModelCatalogEntry>,
    val reported: Boolean,
)

data class EnvironmentRef(
    val id: String,
    val label: String,
    val kind: String,
    val host: String? = null,
    val port: Int? = null,
    val user: String? = null,
    val authMode: String,
    val credentialRef: String? = null,
    val baseUrl: String? = null,
    val hostKeyFingerprint: String? = null,
)

data class MissionError(
    val code: String,
    val message: String,
    val retryable: Boolean? = null,
)

data class Mission(
    val id: String,
    val rootMissionId: String,
    val parentMissionId: String?,
    val depth: Int,
    val title: String,
    val prompt: String,
    val agent: AgentKind?,
    val rawAgent: String,
    val model: ModelRef?,
    val environment: EnvironmentRef?,
    val status: MissionStatus,
    val revision: Int,
    val createdAt: String,
    val updatedAt: String,
    val acceptedAt: String,
    val settledAt: String? = null,
    val activeRunId: String? = null,
    val runIds: List<String> = emptyList(),
    val childIds: List<String> = emptyList(),
    val artifactIds: List<String> = emptyList(),
    val approvalIds: List<String> = emptyList(),
    val wakeGeneration: Int = 0,
    val error: MissionError? = null,
    val cancelReason: String? = null,
)

data class MissionTreeNode(
    val mission: Mission,
    val children: List<MissionTreeNode>,
)

/** One row of the append-only mission log. `source` is `adapter` or
 * `authority`; `type` is the adapter event name or the authority record name. */
data class MissionLogEntry(
    val seq: Long,
    val eventId: String,
    val missionId: String,
    val runId: String?,
    val at: String,
    val source: String,
    val type: String,
    val payload: JsonObject,
    val adapterSeq: Int? = null,
)

data class TerminalRef(
    val id: String,
    val kind: TerminalKind?,
    val missionId: String,
    val runId: String,
    val createdAt: String,
    val closedAt: String? = null,
    val exitCode: Int? = null,
)

data class Approval(
    val id: String,
    val missionId: String,
    val runId: String,
    val status: String,
    val action: String,
    val detail: String,
    val requestedAt: String,
    val expiresAt: String? = null,
    val resolvedAt: String? = null,
    val decidedBy: String? = null,
    val revision: Int,
)

data class Artifact(
    val id: String,
    val missionId: String,
    val runId: String,
    val kind: String,
    val path: String,
    val mediaType: String,
    val bytes: Long,
    val sha256: String? = null,
    val createdAt: String,
)

/** A paired device session as `GET /api/v1/sessions` lists it. */
data class DeviceSession(
    val id: String,
    val label: String,
    val scope: String,
    val createdAt: String,
    val lastUsedAt: String,
    val expiresAt: String,
    val revokedAt: String? = null,
)

data class PairingResult(
    val token: String,
    val sessionId: String,
    val label: String,
    val scope: String,
    val expiresAt: String,
)

data class HealthInfo(
    val status: String,
    val version: String,
    val startedAt: String,
    val now: String,
    val cursor: Long,
    val pairingActive: Boolean,
)

data class TerminalTicket(
    val ticket: String,
    val expiresAt: String?,
    val path: String,
)
