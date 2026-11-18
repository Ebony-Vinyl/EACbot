package com.eacbot.mobile.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.PhonelinkErase
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.DeviceSession
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.ActionText
import com.eacbot.mobile.ui.Gap
import com.eacbot.mobile.ui.GroupCard
import com.eacbot.mobile.ui.GroupLabel
import com.eacbot.mobile.ui.GroupRow
import com.eacbot.mobile.ui.IconTile
import com.eacbot.mobile.ui.PageHeader
import com.eacbot.mobile.ui.ValueRow

/**
 * Settings, and the device list this phone appears in.
 *
 * Revoking another device is the one destructive action here, so it asks first
 * and says what it does. Forgetting this phone revokes its own session before
 * clearing the local credential.
 */
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

    Column(Modifier.fillMaxSize().background(colors.canvasGrouped)) {
        PageHeader(title = "设置", onBack = onBack)
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding(),
        ) {
            GroupLabel("此服务")
            GroupCard {
                ValueRow("地址", state.core?.baseUrl ?: "—", divider = true)
                ValueRow("此手机", state.core?.label ?: "—", divider = true)
                ValueRow(
                    "权限范围",
                    when (state.core?.scope) {
                        "owner" -> "所有者 · 可更改电脑和设备"
                        "device" -> "设备 · 可运行任务、审批和输入"
                        "readonly" -> "只读 · 可查看，不能操作"
                        else -> state.core?.scope ?: "—"
                    },
                )
            }

            GroupLabel("已配对的设备")
            when {
                state.loading -> GroupCard {
                    GroupRow("正在读取设备列表…", trailing = {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accent)
                    })
                }
                state.error != null -> GroupCard {
                    GroupRow(
                        title = "暂时无法读取设备",
                        subtitle = state.error,
                        leading = { IconTile(Icons.Filled.CloudOff, colors.danger, colors.dangerSoft) },
                        trailing = { ActionText("重试", viewModel::load) },
                    )
                }
                state.sessions.isEmpty() -> GroupCard { GroupRow("没有其他设备", trailing = null) }
                else -> GroupCard {
                    state.sessions.forEachIndexed { index, session ->
                        DeviceRow(
                            session = session,
                            isThisPhone = session.id == state.core?.sessionId,
                            divider = index < state.sessions.lastIndex,
                            onRevoke = { revokeTarget = session },
                        )
                    }
                }
            }

            GroupLabel("此手机")
            GroupCard {
                GroupRow(
                    title = "忘记此手机",
                    subtitle = "撤销电脑上的手机会话并删除本机凭据，任务会继续运行。",
                    titleColor = colors.danger,
                    leading = { IconTile(Icons.Filled.PhonelinkErase, colors.danger, colors.dangerSoft) },
                    trailing = null,
                    onClick = { confirmForget = true },
                )
            }
            Gap(32.dp)
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
private fun DeviceRow(session: DeviceSession, isThisPhone: Boolean, divider: Boolean, onRevoke: () -> Unit) {
    val colors = LocalEacbotColors.current
    GroupRow(
        title = session.label.ifBlank { "未命名设备" } + if (isThisPhone) " · 此手机" else "",
        subtitle = "${scopeLabel(session.scope)} · 上次使用 ${session.lastUsedAt.take(16).replace('T', ' ')}",
        leading = {
            IconTile(
                Icons.Filled.Smartphone,
                tint = if (isThisPhone) colors.accent else colors.inkMuted,
                background = if (isThisPhone) colors.accentSoft else colors.surfaceRaised,
            )
        },
        trailing = when {
            session.revokedAt != null -> { { Text("已撤销", style = MaterialTheme.typography.labelMedium, color = colors.danger) } }
            !isThisPhone -> { { ActionText("退出登录", onRevoke, color = colors.danger) } }
            else -> null
        },
        divider = divider,
    )
}

private fun scopeLabel(scope: String) = when (scope) {
    "owner" -> "所有者"
    "device" -> "设备"
    "readonly" -> "只读"
    else -> scope
}
