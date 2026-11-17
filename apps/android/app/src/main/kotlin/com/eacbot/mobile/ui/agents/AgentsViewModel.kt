package com.eacbot.mobile.ui.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.AgentDescriptor
import com.eacbot.mobile.core.AgentModels
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionTreeNode
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.core.SteerCapability
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the command centre shows for one engine. */
data class AgentCard(
    val descriptor: AgentDescriptor,
    val models: AgentModels? = null,
    val modelsKnown: Boolean = false,
)

data class AgentsUiState(
    val loading: Boolean = true,
    val agents: List<AgentCard> = emptyList(),
    val missions: List<Mission> = emptyList(),
    val selectedRootId: String? = null,
    val tree: MissionTreeNode? = null,
    val treeLoading: Boolean = false,
    val history: List<com.eacbot.mobile.core.MissionLogEntry> = emptyList(),
    val historyCursor: Long = 0,
    val historyGap: Boolean = false,
    val error: String? = null,
    val offline: Boolean = false,
)

/**
 * The command centre: what engines this core has, what each can do, and the
 * mission tree with its parallel children.
 *
 * A model list is only "known" when the engine reported one. `reported = false`
 * is a real answer and the screen shows "unknown" rather than an empty list a
 * person would read as "无模型".
 */
class AgentsViewModel(
    private val api: CoreApi,
) : ViewModel() {

    private val state = MutableStateFlow(AgentsUiState())
    val ui: StateFlow<AgentsUiState> = state.asStateFlow()

    fun load() {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val agents = api.agents()
                    val models = agents.associate { agent ->
                        agent.rawKind to runCatching { api.models(agent.rawKind) }.getOrNull()
                    }
                    agents to models
                }
            }
            result
                .onSuccess { (agents, models) ->
                    val cards = agents.map { agent ->
                        val catalog = models[agent.rawKind]
                        AgentCard(
                            descriptor = agent,
                            models = catalog,
                            modelsKnown = catalog?.reported == true && catalog.models.isNotEmpty(),
                        )
                    }
                    state.update { it.copy(loading = false, agents = cards, error = null, offline = false) }
                    refreshMissions()
                }
                .onFailure { error ->
                    state.update { it.copy(loading = false, error = describe(error), offline = error is NetworkException) }
                }
        }
    }

    fun refreshMissions() {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { api.missions() } }
            result
                .onSuccess { missions -> state.update { it.copy(missions = missions) } }
                .onFailure { error -> state.update { it.copy(error = describe(error), offline = error is NetworkException) } }
        }
    }

    /** Loads one mission tree and the log page that follows the cursor the
     * screen already folded. */
    fun selectRoot(missionId: String) {
        state.update { it.copy(selectedRootId = missionId, treeLoading = true, history = emptyList(), historyCursor = 0, historyGap = false) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val tree = api.missionTree(missionId)
                    val page = api.history(missionId, sinceSeq = 0, limit = HISTORY_PAGE)
                    tree to page
                }
            }
            result
                .onSuccess { (tree, page) ->
                    state.update {
                        it.copy(
                            treeLoading = false,
                            tree = tree,
                            history = page.events,
                            historyCursor = page.nextSeq,
                            error = null,
                        )
                    }
                }
                .onFailure { error ->
                    state.update { it.copy(treeLoading = false, error = describe(error)) }
                }
        }
    }

    /** Reads the next log page. A jump in `seq` means the client missed entries,
     * so the screen is told to resync instead of appending a page with a hole. */
    fun loadMoreHistory() {
        val root = state.value.selectedRootId ?: return
        val cursor = state.value.historyCursor
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { api.history(root, sinceSeq = cursor, limit = HISTORY_PAGE) } }
            result
                .onSuccess { page ->
                    state.update { previous ->
                        val expected = if (previous.history.isEmpty()) null else cursor + 1
                        val first = page.events.firstOrNull()?.seq
                        val gap = expected != null && first != null && first > expected
                        previous.copy(
                            history = previous.history + page.events,
                            historyCursor = maxOf(cursor, page.nextSeq),
                            historyGap = gap,
                        )
                    }
                }
                .onFailure { error -> state.update { it.copy(error = describe(error)) } }
        }
    }

    /** The stream said the cursor was too old to replay: rebuild from a
     * snapshot rather than patch. */
    fun resync() {
        val root = state.value.selectedRootId ?: return
        selectRoot(root)
    }

    private fun describe(error: Throwable): String = when (error) {
        is ApiException -> error.details.message
        is NetworkException -> "暂时无法连接你的电脑"
        else -> error.message ?: "发生错误"
    }

    companion object {
        const val HISTORY_PAGE = 200
    }
}

/** How an engine takes a mid-run message, in a sentence a person can act on. */
fun steerDescription(steer: SteerCapability): String = when (steer) {
    SteerCapability.Native -> "支持运行中接收消息"
    is SteerCapability.NextBoundary -> "消息在下一步送达"
    is SteerCapability.None -> "不支持运行中发送消息：${steer.reason}"
}

/** The capabilities worth stating on a card, in the order a person asks them. */
fun capabilityLines(agent: AgentDescriptor): List<Pair<String, Boolean>> = listOf(
    "暂停" to agent.capabilities.interrupt,
    "恢复" to agent.capabilities.resume,
    "取消" to agent.capabilities.cancel,
    "批准事项" to agent.capabilities.approval,
    "问题" to agent.capabilities.questions,
    "协作助手" to agent.capabilities.subagents,
    "图片" to agent.capabilities.images,
    "用量" to agent.capabilities.usage,
)
