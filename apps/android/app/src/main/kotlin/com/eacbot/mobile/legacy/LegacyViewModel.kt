package com.eacbot.mobile.legacy

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.*
import com.eacbot.mobile.data.PairedCore
import com.eacbot.mobile.data.SessionStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import java.util.UUID

data class LegacyState(
    val connected: Boolean = false,
    val bots: List<LegacyBot> = emptyList(),
    val selected: LegacyBot? = null,
    val messages: List<LegacyMessage> = emptyList(),
    val draft: String = "",
    val sending: Boolean = false,
    val error: String? = null,
    val connectionError: String? = null,
)

class LegacyViewModel(private val sessions: SessionStore) : ViewModel() {
    private var api = sessions.load()?.let { LegacyApi(requireNotNull(CoreUrl.normalize(it.baseUrl)), sessions) }
    private val state = MutableStateFlow(LegacyState(connected = api != null))
    val ui = state.asStateFlow()
    private var pendingSend: Pair<String, String>? = null

    suspend fun pair(address: String, code: String, label: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val base = requireNotNull(CoreUrl.normalize(address)) { "服务器地址无效" }
            val client = LegacyApi(base, sessions)
            val result = client.pair(code, label)
            val session = result.getValue("session").jsonObject
            sessions.save(PairedCore(base.toString(), label, session.getValue("id").jsonPrimitive.content,
                "client", session["expiresAt"]?.jsonPrimitive?.content.orEmpty()), result.getValue("token").jsonPrimitive.content)
            api = client
            state.update { LegacyState(connected = true, draft = it.draft) }
        }
    }

    fun select(bot: LegacyBot?) {
        pendingSend = null
        state.update { it.copy(selected = bot, messages = emptyList(), draft = if (it.selected == null) it.draft else "", error = null) }
    }

    fun draft(text: String) { state.update { it.copy(draft = text) } }

    suspend fun refresh() {
        val client = api ?: return
        val selected = state.value.selected
        try {
            if (selected == null) {
                val bots = withContext(Dispatchers.IO) { client.bots() }
                if (api === client) state.update { it.copy(bots = bots, connectionError = null) }
            } else {
                val messages = withContext(Dispatchers.IO) { client.messages(selected.threadId) }
                if (api === client && state.value.selected == selected) state.update { it.copy(messages = messages, connectionError = null) }
            }
        } catch (error: Exception) { failed(error, refreshing = true) }
    }

    fun send() {
        val current = state.value
        val bot = current.selected ?: return
        val client = api ?: return
        val text = current.draft.trim()
        if (text.isEmpty() || current.sending) return
        val sendId = pendingSend?.takeIf { it.first == text }?.second ?: UUID.randomUUID().toString()
        pendingSend = text to sendId
        state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { client.send(bot, text, sendId) }
                pendingSend = null
                if (state.value.selected == bot) state.update { it.copy(draft = "") }
                refresh()
            } catch (error: Exception) { failed(error) }
            finally { state.update { it.copy(sending = false) } }
        }
    }

    fun logout() {
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { api?.logout() }
                sessions.clear()
                api = null
                state.value = LegacyState()
            } catch (error: Exception) { failed(error) }
        }
    }

    private fun failed(error: Exception, refreshing: Boolean = false) {
        if (error is CancellationException) throw error
        if (error is ApiException && error.status == 401) {
            sessions.clear()
            api = null
            state.value = LegacyState(draft = state.value.draft, error = "登录已过期，请重新配对")
        } else state.update {
            if (refreshing) it.copy(connectionError = "连接中断，正在重试")
            else it.copy(error = error.message ?: "连接失败")
        }
    }
}
