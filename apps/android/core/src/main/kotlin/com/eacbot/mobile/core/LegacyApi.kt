package com.eacbot.mobile.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

@Serializable
data class LegacyBot(val id: String, val name: String, val threadId: String)

@Serializable
data class LegacyMessage(val id: String, val role: String, val kind: String, val text: String = "")

@Serializable
private data class LegacyFleet(val bots: List<LegacyBot>)

@Serializable
private data class LegacyHistory(val messages: List<LegacyMessage>, val hasMore: Boolean = false)

class LegacyApi(
    private val base: HttpUrl,
    private val tokens: TokenSource,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(30, TimeUnit.SECONDS).build(),
) {
    private val json = Json { ignoreUnknownKeys = true }

    fun pair(code: String, label: String): JsonObject = request("/api/auth/pair", buildJsonObject {
        put("code", code); put("label", label)
    }, authenticated = false)

    fun bots(): List<LegacyBot> = json.decodeFromJsonElement<LegacyFleet>(request("/api/bots?messages=0")).bots

    fun messages(threadId: String): List<LegacyMessage> = json.decodeFromJsonElement<LegacyHistory>(
        request("/api/threads/${segment(threadId)}/messages?limit=100"),
    ).messages

    fun send(bot: LegacyBot, text: String, sendId: String) {
        request("/api/bots/${segment(bot.id)}/messages", buildJsonObject {
            put("threadId", bot.threadId); put("text", text); put("sendId", sendId)
        })
    }

    fun logout() { request("/api/auth/logout", buildJsonObject {}) }

    private fun request(path: String, body: JsonObject? = null, authenticated: Boolean = true): JsonObject {
        val builder = Request.Builder().url(requireNotNull(base.resolve(path)))
        if (authenticated) tokens.token()?.let { builder.header("Authorization", "Bearer $it") }
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            val parsed = json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
            if (!response.isSuccessful) throw ApiException(response.code, ApiErrorDetails(
                "legacy_http_error", parsed["error"]?.jsonPrimitive?.content ?: "HTTP ${response.code}",
            ))
            return parsed
        }
    }

    private fun segment(value: String) = base.newBuilder().addPathSegment(value).build().encodedPath.substringAfterLast('/')
}
