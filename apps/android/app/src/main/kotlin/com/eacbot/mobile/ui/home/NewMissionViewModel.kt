package com.eacbot.mobile.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.AgentDescriptor
import com.eacbot.mobile.core.AgentModels
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CommandIds
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.EnvironmentRef
import com.eacbot.mobile.core.MissionCommands
import com.eacbot.mobile.core.ModelRef
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.core.UuidCommandIds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class NewMissionUiState(
    val loadingAgents: Boolean = true,
    val loadingModels: Boolean = false,
    val agents: List<AgentDescriptor> = emptyList(),
    val selectedAgent: String? = null,
    val models: AgentModels? = null,
    val selectedModel: String? = null,
    val environments: List<EnvironmentRef> = emptyList(),
    val selectedEnvironment: EnvironmentRef? = null,
    val creating: Boolean = false,
    val error: String? = null,
    val createdMissionId: String? = null,
) {
    val selectedAgentDescriptor: AgentDescriptor?
        get() = agents.firstOrNull { it.rawKind == selectedAgent }
}

/**
 * Starting a mission.
 *
 * The engine list and its model catalog are read, never assumed: an engine with
 * no catalog sends no model at all, and the screen says "unknown" instead of
 * picking a plausible name.
 */
class NewMissionViewModel(
    private val api: CoreApi,
    private val commandIds: CommandIds = UuidCommandIds,
) : ViewModel() {

    private val state = MutableStateFlow(NewMissionUiState())
    val ui: StateFlow<NewMissionUiState> = state.asStateFlow()

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            val loaded = withContext(Dispatchers.IO) {
                runCatching { Triple(api.agents(), api.environments(), Unit) }
            }
            loaded
                .onSuccess { (agents, environments, _) ->
                    val preferred = agents.firstOrNull { it.rawKind == "hermes" } ?: agents.firstOrNull()
                    state.update {
                        it.copy(
                            loadingAgents = false,
                            agents = agents,
                            selectedAgent = preferred?.rawKind,
                            environments = environments,
                            selectedEnvironment = environments.firstOrNull(),
                            error = null,
                        )
                    }
                    preferred?.let { loadModels(it.rawKind) }
                }
                .onFailure { error ->
                    state.update { it.copy(loadingAgents = false, error = describe(error)) }
                }
        }
    }

    fun selectAgent(rawKind: String) {
        state.update { it.copy(selectedAgent = rawKind, models = null, selectedModel = null) }
        loadModels(rawKind)
    }

    private fun loadModels(rawKind: String) {
        state.update { it.copy(loadingModels = true) }
        viewModelScope.launch {
            val models = withContext(Dispatchers.IO) { runCatching { api.models(rawKind) } }
            models
                .onSuccess { catalog ->
                    state.update {
                        // A catalog the engine did not report is `reported = false`,
                        // which the screen shows as "unknown", not as an empty list
                        // it can silently fall back from.
                        if (it.selectedAgent == rawKind) it.copy(models = catalog, loadingModels = false) else it
                    }
                }
                .onFailure {
                    state.update { if (it.selectedAgent == rawKind) it.copy(models = null, loadingModels = false) else it }
                }
        }
    }

    fun selectModel(model: String?) {
        state.update { it.copy(selectedModel = model) }
    }

    fun selectEnvironment(environment: EnvironmentRef) {
        state.update { it.copy(selectedEnvironment = environment) }
    }

    fun create(title: String, prompt: String) {
        val current = state.value
        val agent = current.selectedAgent ?: return
        val environment = current.selectedEnvironment ?: return
        if (current.creating) return
        state.update { it.copy(creating = true, error = null) }
        viewModelScope.launch {
            val model = current.selectedModel?.let { ModelRef(agent = agent, model = it) }
            val request = MissionCommands.create(
                title = title.trim(),
                prompt = prompt.trim(),
                agent = agent,
                environment = MissionCommands.environmentBody(environment),
                commandId = commandIds.next("create"),
                model = model?.let(MissionCommands::modelBody),
            )
            val result = withContext(Dispatchers.IO) { runCatching { api.execute(request) } }
            result
                .onSuccess { outcome ->
                    state.update { it.copy(creating = false, createdMissionId = outcome.missionId) }
                }
                .onFailure { error ->
                    state.update { it.copy(creating = false, error = describe(error)) }
                }
        }
    }

    private fun describe(error: Throwable): String = when (error) {
        is ApiException -> when (error.details.code) {
            "capability_missing" -> "This engine cannot run that task."
            "not_found" -> "That computer is not on this core any more."
            else -> error.details.message
        }
        is NetworkException -> "Can't reach your computer right now"
        else -> error.message ?: "Something went wrong"
    }
}
