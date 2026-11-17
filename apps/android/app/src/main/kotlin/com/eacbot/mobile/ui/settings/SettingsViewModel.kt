package com.eacbot.mobile.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.CoreApi
import com.eacbot.mobile.core.DeviceSession
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.data.CoreConnection
import com.eacbot.mobile.data.PairedCore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class SettingsUiState(
    val core: PairedCore? = null,
    val sessions: List<DeviceSession> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
)

/**
 * The device list and this phone's own credential.
 *
 * Revocation goes through the same connection the rest of the app uses, so a
 * 401 from it clears the session exactly as any other call would.
 */
class SettingsViewModel(
    private val api: CoreApi,
    private val connection: CoreConnection,
) : ViewModel() {

    private val state = MutableStateFlow(SettingsUiState(core = connection.currentCore()))
    val ui: StateFlow<SettingsUiState> = state.asStateFlow()

    fun load() {
        state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { api.sessions() } }
            result
                .onSuccess { sessions -> state.update { it.copy(loading = false, sessions = sessions, error = null) } }
                .onFailure { error -> state.update { it.copy(loading = false, error = describe(error)) } }
        }
    }

    fun revoke(sessionId: String) {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { api.revokeSession(sessionId) } }
            result
                .onSuccess { load() }
                .onFailure { error -> state.update { it.copy(error = describe(error)) } }
        }
    }

    /** Revokes this phone's session, then clears the local credential whatever
     * the answer was: keeping a credential the person asked to delete would be
     * the wrong kind of failure. */
    fun forget() {
        connection.forgetDevice()
    }

    private fun describe(error: Throwable): String = when (error) {
        is ApiException -> when {
            error.isForbidden -> "Only the owner scope can see every device."
            else -> error.details.message
        }
        is NetworkException -> "Can't reach your computer right now"
        else -> error.message ?: "Something went wrong"
    }
}
