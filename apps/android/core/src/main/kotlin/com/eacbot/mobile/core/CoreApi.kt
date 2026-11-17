package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * How a core URL a person typed becomes the base every request uses.
 *
 * A bare host gets `http://` because a self-hosted core on a LAN is reached
 * that way; a host that already names a scheme keeps it. No path, query or
 * fragment survives, because every route here is absolute under `/api/v1`.
 */
object CoreUrl {
    fun normalize(input: String): HttpUrl? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = when {
            trimmed.startsWith("http://", ignoreCase = true) -> trimmed
            trimmed.startsWith("https://", ignoreCase = true) -> trimmed
            else -> "http://$trimmed"
        }
        val parsed = runCatching { withScheme.toHttpUrlOrNull() }.getOrNull() ?: return null
        if (parsed.host.isEmpty()) return null
        return parsed.newBuilder()
            .encodedPath("/")
            .query(null)
            .fragment(null)
            .build()
    }

    /** The socket URL for a terminal stream, from the ticket's own path.
     *
     * OkHttp's `HttpUrl` only accepts http/https, so the ws/wss scheme is
     * written onto the resolved components rather than set on the builder. */
    fun webSocketUrl(base: HttpUrl, path: String, ticket: String): String {
        val resolved = base.resolve(path) ?: base.newBuilder().encodedPath(path).build()
        val scheme = if (resolved.isHttps) "wss" else "ws"
        val port = if (resolved.port == HttpUrl.defaultPort(resolved.scheme)) "" else ":${resolved.port}"
        val query = resolved.newBuilder()
            .addQueryParameter("ticket", ticket)
            .build()
            .encodedQuery
            .orEmpty()
        val target = resolved.encodedPath + if (query.isEmpty()) "" else "?$query"
        return "$scheme://${resolved.host}$port$target"
    }
}

/** Where the bearer lives. The app stores it encrypted; `:core` never persists
 * anything itself. */
fun interface TokenSource {
    fun token(): String?
}

/**
 * The `/api/v1` client.
 *
 * Every method returns a parsed model or throws [ApiException] with the
 * server's own code, and [NetworkException] when no response arrived at all.
 * A 401 is reported to [onUnauthorized] once per request and then thrown, so
 * the caller can clear the session and return to pairing without each screen
 * deciding that for itself.
 */
class CoreApi(
    private val baseUrl: HttpUrl,
    private val tokens: TokenSource,
    private val onUnauthorized: () -> Unit = {},
    private val client: OkHttpClient = defaultClient(),
) {
    val base: HttpUrl get() = baseUrl

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    // ---- health & pairing --------------------------------------------------

    fun health(): HealthInfo = getObject("/api/v1/health").let(WireCodec::parseHealth)

    /** `POST /api/v1/pairing/claim`. This is the one call made without a bearer:
     * it is gated by the one-time code the local terminal printed. */
    fun claimPairing(code: String, label: String, scope: String? = null): PairingResult {
        val body = buildJsonObject {
            put("code", code)
            put("label", label)
            if (scope != null) put("scope", scope)
        }
        val parsed = postObject("/api/v1/pairing/claim", body, authenticated = false)
        return WireCodec.parsePairing(parsed)
            ?: throw ApiException(500, ApiErrorDetails("malformed_response", "the server did not return a token"))
    }

    // ---- sessions ---------------------------------------------------------

    fun sessions(): List<DeviceSession> = WireCodec.parseSessions(getObject("/api/v1/sessions"))

    /** Revokes this device's own session, which is what "forget this phone"
     * does before the local credential is cleared. */
    fun revokeSession(sessionId: String) {
        delete("/api/v1/sessions/${encode(sessionId)}")
    }

    fun revokeAllSessions() {
        postObject("/api/v1/sessions/revoke-all", buildJsonObject {})
    }

    // ---- agents -----------------------------------------------------------

    fun agents(): List<AgentDescriptor> = WireCodec.parseAgents(getObject("/api/v1/agents"))

    fun models(kind: String): AgentModels =
        WireCodec.models(getObject("/api/v1/agents/${encode(kind)}/models"))

    // ---- missions ---------------------------------------------------------

    fun missions(): List<Mission> = WireCodec.parseMissions(getObject("/api/v1/missions"))

    fun mission(missionId: String): Mission =
        WireCodec.mission(getObject("/api/v1/missions/${encode(missionId)}").objectOrNull("mission"))
            ?: throw ApiException(404, ApiErrorDetails("not_found", "no such mission"))

    fun missionTree(missionId: String): MissionTreeNode =
        WireCodec.missionTree(getObject("/api/v1/missions/${encode(missionId)}/tree").objectOrNull("tree"))
            ?: throw ApiException(404, ApiErrorDetails("not_found", "no such mission"))

    /** One page of the append-only log. `sinceSeq` is exclusive, so a caller
     * sends the last `seq` it folded and gets the next entries. */
    fun history(missionId: String, sinceSeq: Long? = null, limit: Int? = null): HistoryPage {
        val body = getObject(MissionCommands.historyPath(missionId, sinceSeq, limit))
        val events = WireCodec.parseHistory(body)
        return HistoryPage(
            events = events,
            nextSeq = WireCodec.parseHistoryNextSeq(body, events.lastOrNull()?.seq ?: sinceSeq ?: 0L),
        )
    }

    fun execute(request: MissionCommandRequest): CommandResult =
        WireCodec.parseCommandResult(postObject(request.path, request.body))

    // ---- environments -----------------------------------------------------

    fun environments(): List<EnvironmentRef> = WireCodec.parseEnvironments(getObject("/api/v1/environments"))

    // ---- terminals --------------------------------------------------------

    fun terminals(): List<TerminalRef> = WireCodec.parseTerminals(getObject("/api/v1/terminals"))

    /**
     * The noVNC entry for the user's own computer.
     *
     * The address is validated before the app will load it: a viewer on another
     * origin would turn this screen into a browser for a third party.
     */
    fun desktop(): DesktopEntry {
        val response = try {
            getObject(DesktopViewer.PATH)
        } catch (error: ApiException) {
            if (error.status == 404 || error.details.code == "not_implemented") return DesktopEntry.NotSupported
            return DesktopEntry.Unavailable(error.details.message)
        }
        return DesktopViewer.fromResponse(baseUrl, response)
    }

    /** A single-use ticket bound to one terminal. A WebSocket cannot carry an
     * Authorization header, so this is the only way in. */
    fun terminalTicket(terminalId: String): TerminalTicket =
        WireCodec.parseTicket(postObject("/api/v1/terminals/${encode(terminalId)}/ticket", buildJsonObject {}))
            ?: throw ApiException(500, ApiErrorDetails("malformed_response", "the server issued no ticket"))

    // ---- transport --------------------------------------------------------

    fun newCall(request: Request): Call = client.newCall(request)

    /** The current bearer, for transports that build their own request (SSE). */
    fun bearer(): String? = tokens.token()

    fun authorizedRequest(path: String, method: String = "GET", body: okhttp3.RequestBody? = null): Request {
        val url = resolve(path)
        val builder = Request.Builder().url(url).method(method, body)
        val token = tokens.token()
        if (token != null) builder.header("authorization", "Bearer $token")
        builder.header("accept", "application/json")
        return builder.build()
    }

    fun resolve(path: String): HttpUrl {
        val url = baseUrl.resolve(path) ?: throw IllegalArgumentException("cannot resolve $path against $baseUrl")
        return url
    }

    private fun getObject(path: String): JsonObject = execute(authorizedRequest(path))

    private fun delete(path: String) {
        val request = authorizedRequest(path, method = "DELETE")
        call(request) { }
    }

    private fun postObject(
        path: String,
        body: JsonObject,
        authenticated: Boolean = true,
    ): JsonObject {
        val payload = body.toString().toRequestBody(jsonMedia)
        val request = if (authenticated) {
            authorizedRequest(path, method = "POST", body = payload)
        } else {
            Request.Builder().url(resolve(path)).post(payload).header("accept", "application/json").build()
        }
        return execute(request)
    }

    private fun execute(request: Request): JsonObject {
        var result: JsonObject? = null
        call(request) { parsed -> result = parsed }
        return result ?: JsonObject(emptyMap())
    }

    /** One request. `onBody` receives the parsed object, if any. A 401 is
     * reported once and then thrown; a non-2xx is always an [ApiException]. */
    private fun call(request: Request, onBody: (JsonObject?) -> Unit) {
        val response: Response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw NetworkException(error.message ?: "the core did not answer", error)
        }
        response.use { answer ->
            val text = runCatching { answer.body?.string() }.getOrNull()
            val parsed = parseObject(text)
            if (answer.code == 401) onUnauthorized()
            if (!answer.isSuccessful) throw ErrorCodec.parse(answer.code, parsed)
            onBody(parsed)
        }
    }

    private fun parseObject(text: String?): JsonObject? {
        if (text.isNullOrBlank()) return null
        return runCatching { wireJson.parseToJsonElement(text).asObjectOrNull() }.getOrNull()
    }

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        /** The streaming client: no read timeout, because an SSE connection is
         * idle by design between notifications. */
        fun streamingClient(): OkHttpClient = defaultClient().newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }
}

data class HistoryPage(val events: List<MissionLogEntry>, val nextSeq: Long)
