package com.eacbot.mobile.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionFilter
import com.eacbot.mobile.core.MissionLogEntry
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.core.MissionTree
import com.eacbot.mobile.core.summarizeChildren
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.EmptyNote
import com.eacbot.mobile.ui.SectionLabel
import com.eacbot.mobile.ui.StatusPill
import com.eacbot.mobile.ui.statusLabel

/**
 * The command centre.
 *
 * Engines first, because a missing capability is something a person should know
 * before they delegate. Then the mission tree, with parallel children indented
 * and counted, and the raw event log with its sequence numbers so a gap is
 * visible instead of silent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentsScreen(
    viewModel: AgentsViewModel,
    onBack: () -> Unit,
    onOpenMission: (String) -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val colors = LocalEacbotColors.current
    var filter by remember { mutableStateOf(MissionFilter.All) }
    var showLog by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { if (state.agents.isEmpty()) viewModel.load() }

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            TopAppBar(
                title = { Text("智能体", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    TextButton(onClick = { viewModel.load() }) { Text("刷新") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.canvas, titleContentColor = colors.ink),
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = EacbotDimens.gutter,
                end = EacbotDimens.gutter,
                bottom = 40.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (state.loading) {
                item { CentredProgress { CircularProgressIndicator(color = colors.accent) } }
            }
            state.error?.let { message ->
                item { Text(message, style = MaterialTheme.typography.bodyMedium, color = colors.danger) }
            }
            if (state.offline) {
                item {
                    Text(
                        "已离线，显示此手机最后读取的内容。",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.inkMuted,
                    )
                }
            }

            item { SectionLabel("此服务上的引擎") }
            items(state.agents, key = { it.descriptor.rawKind }) { card ->
                AgentCardRow(card)
            }

            item { SectionLabel("任务") }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    MissionFilter.entries.forEach { option ->
                        FilterChip(
                            selected = filter == option,
                            onClick = { filter = option },
                            label = { Text(option.label, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
            }

            val roots = state.missions
                .filter { it.parentMissionId == null }
                .filter { filter.matches(it.status) }
            if (roots.isEmpty() && !state.loading) {
                item {
                    EmptyNote(
                        "暂无任务",
                        "任务是委派给引擎的一项工作，可从 Hermes 标签页启动。",
                    )
                }
            }
            items(roots, key = { it.id }) { root ->
                RootMissionRow(
                    root = root,
                    selected = state.selectedRootId == root.id,
                    onClick = {
                        viewModel.selectRoot(root.id)
                        onOpenMission(root.id)
                    },
                    onShowTree = { viewModel.selectRoot(root.id) },
                )
            }

            if (state.selectedRootId != null) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        SectionLabel("任务树")
                        if (state.treeLoading) {
                            Text("正在读取任务树…", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                        }
                        val tree = state.tree
                        if (tree != null) {
                            val summary = summarizeChildren(tree)
                            Text(
                                "${summary.total} 个协作助手 · ${summary.running} 个运行中 · ${summary.waiting} 个等待中 · ${summary.succeeded} 个已完成",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.inkMuted,
                            )
                            MissionTree.flatten(tree).forEach { row ->
                                TreeRowView(row.node.mission, row.depth)
                            }
                        }
                    }
                }

                item {
                    TextButton(onClick = { showLog = !showLog }) {
                        Text(if (showLog) "隐藏事件日志" else "显示事件日志")
                    }
                }
                if (showLog) {
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            if (state.historyGap) {
                                Text(
                                    "日志发生跳跃，正在从快照重新同步。",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.attention,
                                )
                                TextButton(onClick = viewModel::resync) { Text("重新同步") }
                            }
                            state.history.takeLast(40).forEach { entry -> LogLine(entry) }
                            if (state.history.isNotEmpty()) {
                                TextButton(onClick = viewModel::loadMoreHistory) { Text("加载更多事件") }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AgentCardRow(card: AgentCard) {
    val colors = LocalEacbotColors.current
    val shape = RoundedCornerShape(EacbotDimens.cardRadius)
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.surface, shape)
            .border(EacbotDimens.hairline, colors.outline, shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(card.descriptor.label, style = MaterialTheme.typography.titleSmall, color = colors.ink, modifier = Modifier.weight(1f))
            Text(card.descriptor.rawKind, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
        }
        Text(
            steerDescription(card.descriptor.capabilities.steer),
            style = MaterialTheme.typography.labelSmall,
            color = if (card.descriptor.capabilities.canSteer) colors.inkMuted else colors.attention,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            capabilityLines(card.descriptor).forEach { (name, present) ->
                Text(
                    text = if (present) name else "$name 已关闭",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (present) colors.inkMuted else colors.danger,
                )
            }
        }
        Text(
            text = when {
                card.modelsKnown -> card.models?.models?.joinToString(" · ") { it.ref.display } ?: ""
                card.models != null && !card.models.reported -> "模型：未知（此引擎未提供列表）"
                else -> "模型：未知"
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (card.modelsKnown) colors.inkMuted else colors.attention,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun RootMissionRow(
    root: Mission,
    selected: Boolean,
    onClick: () -> Unit,
    onShowTree: () -> Unit,
) {
    val colors = LocalEacbotColors.current
    val shape = RoundedCornerShape(EacbotDimens.cardRadius)
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (selected) colors.surfaceRaised else colors.surface, shape)
            .border(EacbotDimens.hairline, if (selected) colors.accent else colors.outline, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(root.title.ifBlank { "未命名" }, style = MaterialTheme.typography.titleSmall, color = colors.ink, maxLines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusPill(root.status, compact = true)
            Text("版本 ${root.revision}", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
            if (root.childIds.isNotEmpty()) {
                Text("${root.childIds.size} 个协作助手", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onShowTree) { Text("任务树", style = MaterialTheme.typography.labelSmall) }
        }
    }
}

@Composable
private fun TreeRowView(mission: Mission, depth: Int) {
    val colors = LocalEacbotColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = (depth * 14).dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("·", color = colors.inkMuted, style = MaterialTheme.typography.labelSmall)
        Text(
            text = mission.title.ifBlank { mission.id },
            style = MaterialTheme.typography.bodySmall,
            color = colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(statusLabel(mission.status), style = MaterialTheme.typography.labelSmall, color = statusColor(mission.status))
    }
}

@Composable
private fun statusColor(status: MissionStatus) = when (status) {
    MissionStatus.Failed -> LocalEacbotColors.current.danger
    MissionStatus.Succeeded -> LocalEacbotColors.current.success
    MissionStatus.WaitingInput, MissionStatus.WaitingChildren -> LocalEacbotColors.current.attention
    else -> LocalEacbotColors.current.inkMuted
}

@Composable
private fun LogLine(entry: MissionLogEntry) {
    val colors = LocalEacbotColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = entry.seq.toString().padStart(4, ' '),
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = colors.inkMuted,
            modifier = Modifier.width(44.dp),
        )
        Text(
            text = entry.type,
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = if (entry.source == "adapter") colors.ink else colors.accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun CentredProgress(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}
