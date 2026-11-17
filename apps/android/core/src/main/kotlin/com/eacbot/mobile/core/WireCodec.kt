package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Turns the core's JSON into the models above.
 *
 * The rule everywhere: a field the protocol marks optional may be absent, and
 * one record this client cannot read is skipped rather than hiding every
 * healthy sibling. A record missing a field the protocol requires is malformed
 * and is dropped with a reason, never filled in with a guess.
 */
object WireCodec {

    fun parseHealth(body: JsonObject): HealthInfo {
        val status = body.stringOrNull("status") ?: "unknown"
        return HealthInfo(
            status = status,
            version = body.stringOrNull("version") ?: "",
            startedAt = body.stringOrNull("startedAt") ?: "",
            now = body.stringOrNull("now") ?: "",
            cursor = body.longOrNull("cursor") ?: 0L,
            pairingActive = body.booleanOrNull("pairing") == true,
        )
    }

    fun parsePairing(body: JsonObject): PairingResult? {
        val token = body.stringOrNull("token") ?: return null
        val session = body.objectOrNull("session") ?: return null
        return PairingResult(
            token = token,
            sessionId = session.stringOrNull("id") ?: "",
            label = session.stringOrNull("label") ?: "",
            scope = session.stringOrNull("scope") ?: "device",
            expiresAt = session.stringOrNull("expiresAt") ?: "",
        )
    }

    fun parseSessions(body: JsonObject): List<DeviceSession> =
        array(body, "sessions").mapNotNull { element ->
            val record = element.asObjectOrNull() ?: return@mapNotNull null
            val id = record.stringOrNull("id") ?: return@mapNotNull null
            DeviceSession(
                id = id,
                label = record.stringOrNull("label") ?: "",
                scope = record.stringOrNull("scope") ?: "",
                createdAt = record.stringOrNull("createdAt") ?: "",
                lastUsedAt = record.stringOrNull("lastUsedAt") ?: "",
                expiresAt = record.stringOrNull("expiresAt") ?: "",
                revokedAt = record.stringOrNull("revokedAt"),
            )
        }

    fun parseAgents(body: JsonObject): List<AgentDescriptor> =
        array(body, "agents").mapNotNull { element ->
            element.asObjectOrNull()?.let(::agent)
        }

    fun agent(record: JsonObject): AgentDescriptor? {
        val rawKind = record.stringOrNull("kind") ?: return null
        return AgentDescriptor(
            kind = AgentKind.fromWire(rawKind),
            rawKind = rawKind,
            label = record.stringOrNull("label") ?: rawKind,
            authModes = (record["authModes"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
                .mapNotNull(AuthMode::fromWire),
            capabilities = capabilities(record.objectOrNull("capabilities")),
            models = (record["models"] as? JsonArray).orEmpty().mapNotNull { entry(it.asObjectOrNull()) },
        )
    }

    fun capabilities(record: JsonObject?): AgentCapabilities {
        if (record == null) return AgentCapabilities.NONE
        return AgentCapabilities(
            events = record.booleanOrNull("events") == true,
            steer = steer(record["steer"]),
            interrupt = record.booleanOrNull("interrupt") == true,
            resume = record.booleanOrNull("resume") == true,
            cancel = record.booleanOrNull("cancel") == true,
            approval = record.booleanOrNull("approval") == true,
            questions = record.booleanOrNull("questions") == true,
            nativeTui = record.booleanOrNull("nativeTui") == true,
            modelCatalog = record.booleanOrNull("modelCatalog") == true,
            subagents = record.booleanOrNull("subagents") == true,
            images = record.booleanOrNull("images") == true,
            usage = record.booleanOrNull("usage") == true,
            fileChanges = record.booleanOrNull("fileChanges") == true,
        )
    }

    private fun steer(element: kotlinx.serialization.json.JsonElement?): SteerCapability {
        val record = element?.asObjectOrNull() ?: return SteerCapability.None("the engine reported no steering mode")
        return when (record.stringOrNull("kind")) {
            "native" -> SteerCapability.Native
            "next-boundary" -> SteerCapability.NextBoundary(record.stringOrNull("note") ?: "delivered at the engine's next step")
            else -> SteerCapability.None(record.stringOrNull("reason") ?: "the engine takes no mid-turn input")
        }
    }

    fun models(body: JsonObject): AgentModels = AgentModels(
        agent = body.stringOrNull("agent") ?: "",
        models = (body["models"] as? JsonArray).orEmpty().mapNotNull { entry(it.asObjectOrNull()) },
        reported = body.booleanOrNull("reported") == true,
    )

    fun entry(record: JsonObject?): ModelCatalogEntry? {
        val ref = record?.objectOrNull("ref") ?: return null
        val model = ref.stringOrNull("model") ?: return null
        return ModelCatalogEntry(
            ref = ModelRef(
                agent = ref.stringOrNull("agent") ?: "",
                model = model,
                effort = ref.stringOrNull("effort"),
                variant = ref.stringOrNull("variant"),
                label = ref.stringOrNull("label"),
            ),
            contextWindow = record.intOrNull("contextWindow"),
            maxOutputTokens = record.intOrNull("maxOutputTokens"),
            supportsImages = record.booleanOrNull("supportsImages"),
            defaultEffort = record.stringOrNull("defaultEffort"),
            efforts = (record["efforts"] as? JsonArray).orEmpty()
                .mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content },
        )
    }

    fun modelRef(record: JsonObject?): ModelRef? {
        if (record == null) return null
        val model = record.stringOrNull("model") ?: return null
        return ModelRef(
            agent = record.stringOrNull("agent") ?: "",
            model = model,
            effort = record.stringOrNull("effort"),
            variant = record.stringOrNull("variant"),
            label = record.stringOrNull("label"),
        )
    }

    fun environment(record: JsonObject?): EnvironmentRef? {
        if (record == null) return null
        val id = record.stringOrNull("id") ?: return null
        return EnvironmentRef(
            id = id,
            label = record.stringOrNull("label") ?: id,
            kind = record.stringOrNull("kind") ?: "local",
            host = record.stringOrNull("host"),
            port = record.intOrNull("port"),
            user = record.stringOrNull("user"),
            authMode = record.stringOrNull("authMode") ?: "local",
            credentialRef = record.stringOrNull("credentialRef"),
            baseUrl = record.stringOrNull("baseUrl"),
            hostKeyFingerprint = record.stringOrNull("hostKeyFingerprint"),
        )
    }

    fun parseEnvironments(body: JsonObject): List<EnvironmentRef> =
        array(body, "environments").mapNotNull { environment(it.asObjectOrNull()) }

    fun mission(record: JsonObject?): Mission? {
        if (record == null) return null
        val id = record.stringOrNull("id") ?: return null
        val status = MissionStatus.fromWire(record.stringOrNull("status")) ?: return null
        val rawAgent = record.stringOrNull("agent") ?: ""
        return Mission(
            id = id,
            rootMissionId = record.stringOrNull("rootMissionId") ?: id,
            parentMissionId = record.stringOrNull("parentMissionId"),
            depth = record.intOrNull("depth") ?: 0,
            title = record.stringOrNull("title") ?: "",
            prompt = record.stringOrNull("prompt") ?: "",
            agent = AgentKind.fromWire(rawAgent),
            rawAgent = rawAgent,
            model = modelRef(record.objectOrNull("model")),
            environment = environment(record.objectOrNull("environment")),
            status = status,
            revision = record.intOrNull("revision") ?: 0,
            createdAt = record.stringOrNull("createdAt") ?: "",
            updatedAt = record.stringOrNull("updatedAt") ?: "",
            acceptedAt = record.stringOrNull("acceptedAt") ?: "",
            settledAt = record.stringOrNull("settledAt"),
            activeRunId = record.stringOrNull("activeRunId"),
            runIds = strings(record, "runIds"),
            childIds = strings(record, "childIds"),
            artifactIds = strings(record, "artifactIds"),
            approvalIds = strings(record, "approvalIds"),
            wakeGeneration = record.intOrNull("wakeGeneration") ?: 0,
            error = record.objectOrNull("error")?.let {
                MissionError(
                    code = it.stringOrNull("code") ?: "error",
                    message = it.stringOrNull("message") ?: "",
                    retryable = it.booleanOrNull("retryable"),
                )
            },
            cancelReason = record.stringOrNull("cancelReason"),
        )
    }

    fun parseMissions(body: JsonObject): List<Mission> =
        array(body, "missions").mapNotNull { mission(it.asObjectOrNull()) }

    fun missionTree(record: JsonObject?): MissionTreeNode? {
        if (record == null) return null
        val mission = mission(record.objectOrNull("mission")) ?: return null
        return MissionTreeNode(
            mission = mission,
            children = (record["children"] as? JsonArray).orEmpty().mapNotNull { missionTree(it.asObjectOrNull()) },
        )
    }

    fun parseHistory(body: JsonObject): List<MissionLogEntry> =
        array(body, "events").mapNotNull { element ->
            val record = element.asObjectOrNull() ?: return@mapNotNull null
            val seq = record.longOrNull("seq") ?: return@mapNotNull null
            val type = record.stringOrNull("type") ?: return@mapNotNull null
            MissionLogEntry(
                seq = seq,
                eventId = record.stringOrNull("eventId") ?: "",
                missionId = record.stringOrNull("missionId") ?: "",
                runId = record.stringOrNull("runId"),
                at = record.stringOrNull("at") ?: "",
                source = record.stringOrNull("source") ?: "authority",
                type = type,
                payload = record.objectOrNull("payload") ?: JsonObject(emptyMap()),
                adapterSeq = record.intOrNull("adapterSeq"),
            )
        }

    fun parseHistoryNextSeq(body: JsonObject, fallback: Long): Long = body.longOrNull("nextSeq") ?: fallback

    fun parseTerminals(body: JsonObject): List<TerminalRef> =
        array(body, "terminals").mapNotNull { element ->
            val record = element.asObjectOrNull() ?: return@mapNotNull null
            val id = record.stringOrNull("id") ?: return@mapNotNull null
            TerminalRef(
                id = id,
                kind = TerminalKind.fromWire(record.stringOrNull("kind")),
                missionId = record.stringOrNull("missionId") ?: "",
                runId = record.stringOrNull("runId") ?: "",
                createdAt = record.stringOrNull("createdAt") ?: "",
                closedAt = record.stringOrNull("closedAt"),
                exitCode = record.intOrNull("exitCode"),
            )
        }

    fun parseTicket(body: JsonObject): TerminalTicket? {
        val ticket = body.stringOrNull("ticket") ?: return null
        return TerminalTicket(
            ticket = ticket,
            expiresAt = body.stringOrNull("expiresAt"),
            path = body.stringOrNull("path") ?: "",
        )
    }

    fun approval(record: JsonObject?): Approval? {
        if (record == null) return null
        val id = record.stringOrNull("id") ?: return null
        return Approval(
            id = id,
            missionId = record.stringOrNull("missionId") ?: "",
            runId = record.stringOrNull("runId") ?: "",
            status = record.stringOrNull("status") ?: "pending",
            action = record.stringOrNull("action") ?: "",
            detail = record.stringOrNull("detail") ?: "",
            requestedAt = record.stringOrNull("requestedAt") ?: "",
            expiresAt = record.stringOrNull("expiresAt"),
            resolvedAt = record.stringOrNull("resolvedAt"),
            decidedBy = record.stringOrNull("decidedBy"),
            revision = record.intOrNull("revision") ?: 0,
        )
    }

    fun artifact(record: JsonObject?): Artifact? {
        if (record == null) return null
        val id = record.stringOrNull("id") ?: return null
        return Artifact(
            id = id,
            missionId = record.stringOrNull("missionId") ?: "",
            runId = record.stringOrNull("runId") ?: "",
            kind = record.stringOrNull("kind") ?: "file",
            path = record.stringOrNull("path") ?: "",
            mediaType = record.stringOrNull("mediaType") ?: "application/octet-stream",
            bytes = record.longOrNull("bytes") ?: 0L,
            sha256 = record.stringOrNull("sha256"),
            createdAt = record.stringOrNull("createdAt") ?: "",
        )
    }

    fun parseCommandResult(record: JsonObject): CommandResult {
        val type = record.stringOrNull("type") ?: ""
        return CommandResult(
            commandId = record.stringOrNull("commandId") ?: "",
            type = type,
            missionId = record.stringOrNull("missionId") ?: "",
            appliedAt = record.stringOrNull("appliedAt") ?: "",
            missionRevision = record.intOrNull("missionRevision") ?: 0,
            replayed = record.booleanOrNull("replayed") == true,
            runId = record.stringOrNull("runId"),
            affectedMissionIds = strings(record, "affectedMissionIds"),
            affectedRunIds = strings(record, "affectedRunIds"),
        )
    }

    fun strings(record: JsonObject, key: String): List<String> =
        (record[key] as? JsonArray).orEmpty().mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }

    fun array(record: JsonObject, key: String): JsonArray = (record[key] as? JsonArray) ?: JsonArray(emptyList())
}
