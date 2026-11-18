package com.eacbot.mobile.ui.computer

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DesktopAccessDisabled
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.DesktopEntry
import com.eacbot.mobile.core.TerminalKind
import com.eacbot.mobile.core.TerminalRef
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.ActionText
import com.eacbot.mobile.ui.Chevron
import com.eacbot.mobile.ui.CircleButton
import com.eacbot.mobile.ui.Gap
import com.eacbot.mobile.ui.GroupCard
import com.eacbot.mobile.ui.GroupLabel
import com.eacbot.mobile.ui.GroupRow
import com.eacbot.mobile.ui.IconTile
import com.eacbot.mobile.ui.NoticeBanner
import com.eacbot.mobile.ui.PageHeader
import com.eacbot.mobile.ui.StatusTone

/**
 * The computer card for one mission: the desktop entry and the terminals the
 * agent opened.
 *
 * This is the second level of the phone's structure, not a desktop pane. The
 * full-screen desktop and a terminal are both one tap from here.
 */
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

    Column(Modifier.fillMaxSize().background(colors.canvasGrouped)) {
        PageHeader(
            title = "电脑",
            subtitle = missionTitle,
            onBack = onBack,
            actions = { CircleButton(Icons.Filled.Refresh, "刷新", viewModel::load) },
        )
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding(),
        ) {
            state.error?.let { message ->
                Gap(8.dp)
                NoticeBanner(message, tone = StatusTone.Failed)
            }

            GroupLabel("桌面")
            GroupCard {
                when (val desktop = state.desktop) {
                    is DesktopEntry.Ready -> GroupRow(
                        title = desktop.label,
                        subtitle = "查看并操作智能体正在使用的桌面",
                        leading = { IconTile(Icons.Filled.DesktopWindows, colors.accent, colors.accentSoft) },
                        trailing = { ActionText("打开", { onOpenDesktop(desktop.url.toString()) }) },
                        onClick = { onOpenDesktop(desktop.url.toString()) },
                    )
                    is DesktopEntry.Unavailable -> DesktopNote(desktop.reason, StatusTone.Quiet)
                    DesktopEntry.NotSupported -> DesktopNote("此服务未提供桌面查看器，仍可使用终端。", StatusTone.Quiet)
                    is DesktopEntry.Refused -> DesktopNote(desktop.reason, StatusTone.Failed)
                    null -> GroupRow(
                        title = if (state.loading) "正在读取桌面入口…" else "暂无桌面信息",
                        leading = { IconTile(Icons.Filled.DesktopWindows, colors.inkMuted, colors.surfaceRaised) },
                        trailing = if (state.loading) {
                            { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accent) }
                        } else null,
                    )
                }
            }

            GroupLabel("终端")
            if (state.terminals.isEmpty() && !state.loading) {
                GroupCard {
                    GroupRow(
                        title = "此任务暂无终端",
                        subtitle = "智能体在电脑上打开终端后会显示在这里。",
                        leading = { IconTile(Icons.Filled.Terminal, colors.inkMuted, colors.surfaceRaised) },
                        trailing = null,
                    )
                }
            } else if (state.terminals.isNotEmpty()) {
                GroupCard {
                    state.terminals.forEachIndexed { index, terminal ->
                        TerminalRow(terminal, index < state.terminals.lastIndex) { onOpenTerminal(terminal.id) }
                    }
                }
            }
            Gap(32.dp)
        }
    }
}

@Composable
private fun DesktopNote(text: String, tone: StatusTone) {
    val colors = LocalEacbotColors.current
    val (ink, soft) = tone.colors(colors)
    GroupRow(
        title = "桌面不可用",
        subtitle = text,
        leading = { IconTile(Icons.Filled.DesktopAccessDisabled, ink, soft) },
        trailing = null,
    )
}

@Composable
private fun TerminalRow(terminal: TerminalRef, divider: Boolean, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    val open = terminal.closedAt == null
    GroupRow(
        title = when (terminal.kind) {
            TerminalKind.NativeTui -> "智能体终端"
            TerminalKind.Pty -> "命令行"
            TerminalKind.Exec -> "命令"
            null -> "终端"
        },
        subtitle = terminal.id,
        leading = {
            IconTile(
                Icons.Filled.Terminal,
                tint = if (open) colors.success else colors.inkMuted,
                background = if (open) colors.successSoft else colors.surfaceRaised,
            )
        },
        trailing = {
            Text(
                if (open) "运行中" else "已关闭",
                style = MaterialTheme.typography.labelMedium,
                color = if (open) colors.success else colors.inkFaint,
            )
            Chevron()
        },
        divider = divider,
        onClick = onClick,
    )
}
