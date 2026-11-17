package com.eacbot.mobile.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.DeviceSession
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.Hairline
import com.eacbot.mobile.ui.SectionLabel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings, and the device list this phone appears in.
 *
 * Revoking another device is the one destructive action here, so it asks first
 * and says what it does. Forgetting this phone revokes its own session before
 * clearing the local credential.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val colors = LocalEacbotColors.current
    var confirmForget by remember { mutableStateOf(false) }
    var revokeTarget by remember { mutableStateOf<DeviceSession?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            TopAppBar(
                title = { Text("Settings", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.canvas, titleContentColor = colors.ink),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = EacbotDimens.gutterWide, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SectionLabel("This core")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Address", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(state.core?.baseUrl ?: "—", style = MaterialTheme.typography.labelSmall, color = colors.ink)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This phone", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(state.core?.label ?: "—", style = MaterialTheme.typography.labelSmall, color = colors.ink)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Scope", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(
                    text = when (state.core?.scope) {
                        "owner" -> "Owner · can change computers and devices"
                        "device" -> "Device · can run tasks, approve and type"
                        "readonly" -> "Read only · can watch, cannot act"
                        else -> state.core?.scope ?: "—"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.ink,
                )
            }

            Spacer(Modifier.height(6.dp))
            Hairline()
            SectionLabel("Devices paired to this core")
            if (state.loading) {
                Text("Reading the device list…", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
            }
            state.error?.let { message ->
                Text(message, style = MaterialTheme.typography.bodySmall, color = colors.danger)
                TextButton(onClick = viewModel::load) { Text("Try again") }
            }
            state.sessions.forEach { session ->
                DeviceRow(
                    session = session,
                    isThisPhone = session.id == state.core?.sessionId,
                    onRevoke = { revokeTarget = session },
                )
            }

            Spacer(Modifier.height(8.dp))
            Hairline()
            SectionLabel("This phone")
            Text(
                "Forgetting revokes this phone's session on your computer and deletes the saved credential here. Your tasks keep running.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.inkMuted,
            )
            Button(
                onClick = { confirmForget = true },
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
                colors = ButtonDefaults.buttonColors(containerColor = colors.danger, contentColor = colors.canvas),
            ) { Text("Forget this phone") }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            containerColor = colors.surface,
            title = { Text("Forget this phone?", color = colors.ink) },
            text = {
                Text(
                    "Its session is revoked on your computer and the credential is deleted here. You will need a new pairing code to connect again.",
                    color = colors.inkMuted,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmForget = false
                    viewModel.forget()
                }) { Text("Forget", color = colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Keep") } },
        )
    }

    revokeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { revokeTarget = null },
            containerColor = colors.surface,
            title = { Text("Sign out ${target.label}?", color = colors.ink) },
            text = {
                Text(
                    "That device stops working immediately and must pair again. Tasks already running are not stopped.",
                    color = colors.inkMuted,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val id = target.id
                    revokeTarget = null
                    viewModel.revoke(id)
                }) { Text("Sign out", color = colors.danger) }
            },
            dismissButton = { TextButton(onClick = { revokeTarget = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun DeviceRow(session: DeviceSession, isThisPhone: Boolean, onRevoke: () -> Unit) {
    val colors = LocalEacbotColors.current
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.surface, RoundedCornerShape(EacbotDimens.controlRadius))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(session.label.ifBlank { "Unnamed device" }, style = MaterialTheme.typography.titleSmall, color = colors.ink)
            if (isThisPhone) {
                Text("this phone", style = MaterialTheme.typography.labelSmall, color = colors.accent)
            }
        }
        Text(
            text = "${session.scope} · last used ${session.lastUsedAt}",
            style = MaterialTheme.typography.labelSmall,
            color = colors.inkMuted,
        )
        if (session.revokedAt != null) {
            Text("Revoked", style = MaterialTheme.typography.labelSmall, color = colors.danger)
        } else if (!isThisPhone) {
            TextButton(onClick = onRevoke) { Text("Sign out", style = MaterialTheme.typography.labelSmall) }
        }
    }
}
