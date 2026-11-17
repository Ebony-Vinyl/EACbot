package com.eacbot.mobile.ui.computer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.DesktopEntry
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.core.TerminalRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class ComputerUiState(
    val loading: Boolean = true,
    val terminals: List<TerminalRef> = emptyList(),
    val desktop: DesktopEntry? = null,
    val error: String? = null,
)

/**
 * The computer behind one mission: its terminals and its desktop.
 *
 * Terminals come from the mission's own record, so a phone cannot open one that
 * belongs to a different task. The desktop address is the core's own, validated
 * before the viewer will load it.
 */
class ComputerViewModel(
    private val api: CoreApi,
    private val missionId: String,
) : ViewModel() {

    private val state = MutableStateFlow(ComputerUiState())
    val ui: StateFlow<ComputerUiState> = state.asStateFlow()

    fun load() {
        state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val terminals = api.terminals().filter { it.missionId == missionId }
                    val desktop = api.desktop()
                    terminals to desktop
                }
            }
            result
                .onSuccess { (terminals, desktop) ->
                    state.update { it.copy(loading = false, terminals = terminals, desktop = desktop) }
                }
                .onFailure { error ->
                    state.update { it.copy(loading = false, error = describe(error)) }
                }
        }
    }

    private fun describe(error: Throwable): String = when (error) {
        is ApiException -> error.details.message
        is NetworkException -> "Can't reach your computer right now"
        else -> error.message ?: "Something went wrong"
    }
}
