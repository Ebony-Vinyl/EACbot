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
                title = { Text("设置", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
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
            SectionLabel("此服务")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("地址", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(state.core?.baseUrl ?: "—", style = MaterialTheme.typography.labelSmall, color = colors.ink)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("此手机", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(state.core?.label ?: "—", style = MaterialTheme.typography.labelSmall, color = colors.ink)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("权限范围", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(
                    text = when (state.core?.scope) {
                        "owner" -> "所有者 · 可更改电脑和设备"
                        "device" -> "设备 · 可运行任务、审批和输入"
                        "readonly" -> "只读 · 可查看，不能操作"
                        else -> state.core?.scope ?: "—"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.ink,
                )
            }

            Spacer(Modifier.height(6.dp))
            Hairline()
            SectionLabel("与此服务配对的设备")
            if (state.loading) {
                Text("正在读取设备列表…", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
            }
            state.error?.let { message ->
                Text(message, style = MaterialTheme.typography.bodySmall, color = colors.danger)
                TextButton(onClick = viewModel::load) { Text("重试") }
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
            SectionLabel("此手机")
            Text(
                "忘记后会撤销电脑上的手机会话，并删除本机保存的凭据，任务会继续运行。",
                style = MaterialTheme.typography.bodySmall,
                color = colors.inkMuted,
            )
            Button(
                onClick = { confirmForget = true },
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
                colors = ButtonDefaults.buttonColors(containerColor = colors.danger, contentColor = colors.canvas),
            ) { Text("忘记此手机") }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            containerColor = colors.surface,
            title = { Text("忘记此手机？", color = colors.ink) },
            text = {
                Text(
                    "将撤销电脑上的会话并删除本机凭据。再次连接需要新的配对码。",
                    color = colors.inkMuted,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmForget = false
                    viewModel.forget()
                }) { Text("移除", color = colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("保留") } },
        )
    }

    revokeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { revokeTarget = null },
            containerColor = colors.surface,
            title = { Text("让 ${target.label} 退出登录？", color = colors.ink) },
            text = {
                Text(
                    "该设备将立即失去访问权限，必须重新配对。正在运行的任务不会停止。",
                    color = colors.inkMuted,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val id = target.id
                    revokeTarget = null
                    viewModel.revoke(id)
                }) { Text("退出登录", color = colors.danger) }
            },
            dismissButton = { TextButton(onClick = { revokeTarget = null }) { Text("取消") } },
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
            Text(session.label.ifBlank { "未命名设备" }, style = MaterialTheme.typography.titleSmall, color = colors.ink)
            if (isThisPhone) {
                Text("此手机", style = MaterialTheme.typography.labelSmall, color = colors.accent)
            }
        }
        Text(
            text = "${session.scope} · 上次使用 ${session.lastUsedAt}",
            style = MaterialTheme.typography.labelSmall,
            color = colors.inkMuted,
        )
        if (session.revokedAt != null) {
            Text("已撤销", style = MaterialTheme.typography.labelSmall, color = colors.danger)
        } else if (!isThisPhone) {
            TextButton(onClick = onRevoke) { Text("退出登录", style = MaterialTheme.typography.labelSmall) }
        }
    }
}
