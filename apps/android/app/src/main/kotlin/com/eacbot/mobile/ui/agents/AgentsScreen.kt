package com.eacbot.mobile.ui.agents

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionFilter
import com.eacbot.mobile.core.MissionLogEntry
import com.eacbot.mobile.core.MissionTree
import com.eacbot.mobile.core.summarizeChildren
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.ActionText
import com.eacbot.mobile.ui.CaptionChip
import com.eacbot.mobile.ui.Chevron
import com.eacbot.mobile.ui.ChoiceRow
import com.eacbot.mobile.ui.CircleButton
import com.eacbot.mobile.ui.EmptyNote
import com.eacbot.mobile.ui.Gap
import com.eacbot.mobile.ui.GroupCard
import com.eacbot.mobile.ui.GroupLabel
import com.eacbot.mobile.ui.GroupRow
import com.eacbot.mobile.ui.IconTile
import com.eacbot.mobile.ui.NoticeBanner
import com.eacbot.mobile.ui.PageHeader
import com.eacbot.mobile.ui.StatusPill
import com.eacbot.mobile.ui.StatusTone
import com.eacbot.mobile.ui.statusLabel
import com.eacbot.mobile.ui.statusTone

/**
 * The command centre. Engines first, because a missing capability is something
 * a person should know before they delegate. Then the mission tree, and the raw
 * event log with its sequence numbers so a gap is visible instead of silent.
 */
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

    Column(Modifier.fillMaxSize().background(colors.canvasGrouped)) {
        PageHeader(
            title = "智能体",
            onBack = onBack,
            actions = { CircleButton(Icons.Filled.Refresh, "刷新", { viewModel.load() }) },
        )
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 40.dp)) {
            if (state.loading) {
                item {
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = colors.accent)
                    }
                }
            }
            state.error?.let { message -> item { Gap(8.dp); NoticeBanner(message, tone = StatusTone.Failed) } }
            if (state.offline) item { Gap(8.dp); CaptionChip("已离线，显示此手机最后读取的内容") }

            item { GroupLabel("此服务上的引擎") }
            items(state.agents, key = { it.descriptor.rawKind }) { card ->
                AgentCardView(card)
                Gap(10.dp)
            }

            item { GroupLabel("任务") }
            item { ChoiceRow(MissionFilter.entries, filter, { it.label }, { filter = it }); Gap(10.dp) }

            val roots = state.missions.filter { it.parentMissionId == null && filter.matches(it.status) }
            if (roots.isEmpty() && !state.loading) {
                item {
                    EmptyNote(
                        "暂无任务",
                        "任务是委派给引擎的一项工作，可在任务页新建。",
                        Modifier.padding(horizontal = EacbotDimens.gutter),
                    )
                }
            } else if (roots.isNotEmpty()) {
                item {
                    GroupCard {
                        roots.forEachIndexed { index, root ->
                            RootMissionRow(
                                root = root,
                                selected = state.selectedRootId == root.id,
                                divider = index < roots.lastIndex,
                                onClick = {
                                    viewModel.selectRoot(root.id)
                                    onOpenMission(root.id)
                                },
                                onShowTree = { viewModel.selectRoot(root.id) },
                            )
                        }
                    }
                }
            }

            if (state.selectedRootId != null) {
                item { GroupLabel("任务树") }
                item {
                    GroupCard {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (state.treeLoading) {
                                Text("正在读取任务树…", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
                            }
                            state.tree?.let { tree ->
                                val summary = summarizeChildren(tree)
                                Text(
                                    "${summary.total} 个协作助手 · ${summary.running} 个运行中 · ${summary.waiting} 个等待中 · ${summary.succeeded} 个已完成",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.inkMuted,
                                )
                                MissionTree.flatten(tree).forEach { row -> TreeRowView(row.node.mission, row.depth) }
                            }
                        }
                    }
                }
                item {
                    Box(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
                        ActionText(if (showLog) "隐藏事件日志" else "显示事件日志", { showLog = !showLog })
                    }
                }
                if (showLog) {
                    item {
                        GroupCard {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                if (state.historyGap) {
                                    Text("日志发生跳跃，正在从快照重新同步。", style = MaterialTheme.typography.bodySmall, color = colors.attention)
                                    ActionText("重新同步", viewModel::resync)
                                }
                                state.history.takeLast(40).forEach { entry -> LogLine(entry) }
                                if (state.history.isNotEmpty()) ActionText("加载更多事件", viewModel::loadMoreHistory)
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgentCardView(card: AgentCard) {
    val colors = LocalEacbotColors.current
    val descriptor = card.descriptor
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = EacbotDimens.gutter)
            .clip(RoundedCornerShape(EacbotDimens.groupRadius))
            .background(colors.surface)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconTile(Icons.Filled.AutoAwesome, colors.accent, colors.accentSoft, size = 40.dp)
            Column(Modifier.weight(1f)) {
                Text(descriptor.label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = colors.ink)
                Text(descriptor.rawKind, style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
            }
        }
        Text(
            steerDescription(descriptor.capabilities.steer),
            style = MaterialTheme.typography.bodySmall,
            color = if (descriptor.capabilities.canSteer) colors.inkMuted else colors.attention,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            capabilityLines(descriptor).forEach { (name, present) ->
                val (ink, soft) = (if (present) StatusTone.Done else StatusTone.Failed).colors(colors)
                Text(
                    if (present) name else "$name 已关闭",
                    style = MaterialTheme.typography.labelSmall,
                    color = ink,
                    modifier = Modifier.clip(CircleShape).background(soft).padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        Text(
            when {
                card.modelsKnown -> card.models?.models?.joinToString(" · ") { it.ref.display } ?: ""
                card.models != null && !card.models.reported -> "模型：未知（此引擎未提供列表）"
                else -> "模型：未知"
            },
            style = MaterialTheme.typography.bodySmall,
            color = if (card.modelsKnown) colors.inkMuted else colors.attention,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun RootMissionRow(root: Mission, selected: Boolean, divider: Boolean, onClick: () -> Unit, onShowTree: () -> Unit) {
    val colors = LocalEacbotColors.current
    GroupRow(
        title = root.title.ifBlank { "未命名" },
        subtitle = buildList {
            add(statusLabel(root.status))
            add("版本 ${root.revision}")
            if (root.childIds.isNotEmpty()) add("${root.childIds.size} 个协作助手")
        }.joinToString(" · "),
        leading = {
            val (ink, soft) = statusTone(root.status).colors(colors)
            Box(Modifier.size(22.dp).clip(CircleShape).background(soft), contentAlignment = Alignment.Center) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(ink))
            }
        },
        trailing = {
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(if (selected) colors.accentSoft else colors.surfaceRaised)
                    .clickable(role = Role.Button, onClick = onShowTree)
                    .padding(8.dp),
            ) {
                androidx.compose.material3.Icon(
                    Icons.Filled.AccountTree,
                    contentDescription = "任务树",
                    tint = if (selected) colors.accent else colors.inkMuted,
                    modifier = Modifier.size(18.dp),
                )
            }
            Chevron()
        },
        divider = divider,
        onClick = onClick,
    )
}

@Composable
private fun TreeRowView(mission: Mission, depth: Int) {
    val colors = LocalEacbotColors.current
    Row(
        Modifier.fillMaxWidth().padding(start = (depth * 16).dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            mission.title.ifBlank { mission.id },
            style = MaterialTheme.typography.bodyMedium,
            color = colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        StatusPill(mission.status, compact = true)
    }
}

@Composable
private fun LogLine(entry: MissionLogEntry) {
    val colors = LocalEacbotColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            entry.seq.toString().padStart(4, ' '),
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = colors.inkFaint,
            modifier = Modifier.width(44.dp),
        )
        Text(
            entry.type,
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            color = if (entry.source == "adapter") colors.ink else colors.accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
