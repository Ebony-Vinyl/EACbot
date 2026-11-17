package com.eacbot.mobile.ui.computer

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.DesktopEntry
import com.eacbot.mobile.core.TerminalKind
import com.eacbot.mobile.core.TerminalRef
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.EmptyNote
import com.eacbot.mobile.ui.SectionLabel

/**
 * The computer card for one mission: the desktop entry and the terminals the
 * agent opened.
 *
 * This is the second level of the phone's structure, not a desktop pane. The
 * full-screen desktop and a terminal are both one tap from here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputerScreen(
    missionTitle: String,
    viewModel: ComputerViewModel,
    onBack: () -> Unit,
    onOpenTerminal: (String) -> Unit,
    onOpenDesktop: (String) -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val colors = LocalEacbotColors.current

    LaunchedEffect(Unit) { viewModel.load() }

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("电脑", style = MaterialTheme.typography.titleMedium, color = colors.ink)
                        Text(
                            missionTitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.inkMuted,
                            maxLines = 1,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = { TextButton(onClick = viewModel::load) { Text("刷新") } },
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
            state.error?.let { message ->
                Text(message, style = MaterialTheme.typography.bodyMedium, color = colors.danger)
            }

            SectionLabel("桌面")
            when (val desktop = state.desktop) {
                is DesktopEntry.Ready -> Button(
                    onClick = { onOpenDesktop(desktop.url.toString()) },
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                    shape = RoundedCornerShape(EacbotDimens.controlRadius),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
                ) { Text("打开 ${desktop.label}") }
                is DesktopEntry.Unavailable -> Text(
                    desktop.reason,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.inkMuted,
                )
                DesktopEntry.NotSupported -> Text(
                    "此服务未提供桌面查看器，仍可使用终端。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.inkMuted,
                )
                is DesktopEntry.Refused -> Text(
                    desktop.reason,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.danger,
                )
                null -> if (state.loading) {
                    Text("正在读取桌面入口…", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
                }
            }

            SectionLabel("终端")
            if (state.terminals.isEmpty() && !state.loading) {
                EmptyNote(
                    "此任务暂无终端",
                    "智能体在电脑上打开终端后会显示在这里。",
                )
            }
            state.terminals.forEach { terminal ->
                TerminalRow(terminal) { onOpenTerminal(terminal.id) }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun TerminalRow(terminal: TerminalRef, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    val shape = RoundedCornerShape(EacbotDimens.controlRadius)
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.surface, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = when (terminal.kind) {
                    TerminalKind.NativeTui -> "智能体终端"
                    TerminalKind.Pty -> "命令行"
                    TerminalKind.Exec -> "命令"
                    null -> "终端"
                },
                style = MaterialTheme.typography.titleSmall,
                color = colors.ink,
            )
            Text(terminal.id, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted, maxLines = 1)
        }
        Text(
            text = when {
                terminal.closedAt != null -> "closed"
                else -> "open"
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (terminal.closedAt != null) colors.inkMuted else colors.success,
        )
    }
}
