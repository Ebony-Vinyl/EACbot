package com.eacbot.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionFilter
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.design.enterAnimation
import com.eacbot.mobile.ui.AgentHeader
import com.eacbot.mobile.ui.Chevron
import com.eacbot.mobile.ui.ChoiceRow
import com.eacbot.mobile.ui.CircleButton
import com.eacbot.mobile.ui.EmptyHero
import com.eacbot.mobile.ui.Gap
import com.eacbot.mobile.ui.Hairline
import com.eacbot.mobile.ui.LargeTitle
import com.eacbot.mobile.ui.MenuButton
import com.eacbot.mobile.ui.StatusHeading
import com.eacbot.mobile.ui.StatusTone
import com.eacbot.mobile.ui.floating
import com.eacbot.mobile.ui.statusLabel
import com.eacbot.mobile.ui.statusTone

private const val CollapsedCount = 3

/**
 * The phone's task list, grouped the way a person acts on it: what needs them,
 * what is working, what finished. "等待你处理" sorts first because it is the
 * only state that blocks someone else.
 */
@Composable
fun HomeScreen(
    missions: Map<String, Mission>,
    streamConnected: Boolean,
    offlineNote: String?,
    onOpenMission: (String) -> Unit,
    onCreate: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenAgents: () -> Unit,
    onRefresh: () -> Unit,
) {
    val colors = LocalEacbotColors.current
    var filter by remember { mutableStateOf(MissionFilter.All) }
    var menuOpen by remember { mutableStateOf(false) }
    val expanded = remember { mutableStateOf(setOf<StatusTone>()) }
    val all = missions.values.toList()
    val visible = all
        .filter { filter.matches(it.status) }
        .sortedWith(
            compareBy<Mission>(
                { if (it.status == MissionStatus.WaitingInput) 0 else if (it.status == MissionStatus.WaitingChildren) 1 else 2 },
                { -it.revision },
            ),
        )
    val groups = listOf(
        StatusTone.Waiting to "等你处理",
        StatusTone.Working to "进行中",
        StatusTone.Failed to "失败",
        StatusTone.Done to "已完成",
        StatusTone.Quiet to "已取消",
    ).mapNotNull { (tone, title) ->
        val rows = visible.filter { statusTone(it.status) == tone }
        if (rows.isEmpty()) null else Triple(tone, title, rows)
    }

    Box(Modifier.fillMaxSize().background(colors.canvas)) {
        Column(Modifier.fillMaxSize()) {
            AgentHeader(
                name = "EACbot",
                status = offlineNote ?: if (streamConnected) "实时同步" else "重新连接中",
                statusColor = when {
                    offlineNote != null -> colors.danger
                    streamConnected -> colors.success
                    else -> colors.attention
                },
                leading = { MenuButton() },
                trailing = {
                    Box {
                        CircleButton(Icons.Filled.MoreHoriz, "更多", { menuOpen = true })
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("智能体") },
                                leadingIcon = { Icon(Icons.Filled.AutoAwesome, null) },
                                onClick = { menuOpen = false; onOpenAgents() },
                            )
                            DropdownMenuItem(
                                text = { Text("设置与设备") },
                                leadingIcon = { Icon(Icons.Filled.Settings, null) },
                                onClick = { menuOpen = false; onOpenSettings() },
                            )
                        }
                    }
                },
            )
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 120.dp)) {
                item { LargeTitle("任务") }
                item {
                    ChoiceRow(MissionFilter.entries, filter, { it.label }, { filter = it })
                    Gap(8.dp)
                }
                if (groups.isEmpty()) {
                    item {
                        EmptyHero(
                            title = if (all.isEmpty()) "还没有任务" else "这里没有任务",
                            detail = if (all.isEmpty()) "告诉智能体你想完成什么，它会在你的电脑上处理。" else "切换到“全部”查看其他任务。",
                            action = if (all.isEmpty()) "新建任务" else "查看全部",
                            onAction = { if (all.isEmpty()) onCreate() else filter = MissionFilter.All },
                            modifier = Modifier.padding(top = 40.dp),
                        )
                    }
                }
                groups.forEachIndexed { index, (tone, title, rows) ->
                    val open = tone in expanded.value
                    val shown = if (open) rows else rows.take(CollapsedCount)
                    item(key = "head-$tone") {
                        if (index > 0) Hairline(Modifier.padding(vertical = 8.dp))
                        StatusHeading(title, tone, count = rows.size)
                    }
                    items(shown, key = { it.id }) { mission ->
                        MissionRow(mission) { onOpenMission(mission.id) }
                    }
                    if (rows.size > CollapsedCount) {
                        item(key = "more-$tone") {
                            ShowMoreRow(open, rows.size - CollapsedCount) {
                                expanded.value = if (open) expanded.value - tone else expanded.value + tone
                            }
                        }
                    }
                }
            }
        }
        if (groups.isNotEmpty()) {
            NewTaskButton(
                onCreate,
                Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 20.dp),
            )
        }
    }
}

@Composable
private fun MissionRow(mission: Mission, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    val (ink, soft) = statusTone(mission.status).colors(colors)
    Row(
        Modifier
            .fillMaxWidth()
            .enterAnimation(mission.id)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = EacbotDimens.gutterWide, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            Modifier.padding(top = 2.dp).size(22.dp).clip(CircleShape).background(soft),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(ink))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                mission.title.ifBlank { "未命名任务" },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = colors.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(statusLabel(mission.status), mission.model?.display ?: mission.rawAgent.ifBlank { null })
                    .joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
                color = if (mission.status == MissionStatus.WaitingInput) colors.attention else colors.inkMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (mission.prompt.isNotBlank()) {
                Text(
                    mission.prompt,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.inkFaint,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Chevron()
    }
}

@Composable
private fun ShowMoreRow(open: Boolean, hidden: Int, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    Text(
        if (open) "收起" else "再显示 $hidden 个",
        style = MaterialTheme.typography.bodyMedium,
        color = colors.inkMuted,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 56.dp, end = 20.dp, top = 8.dp, bottom = 12.dp),
    )
}

@Composable
private fun NewTaskButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Row(
        modifier
            .floating(CircleShape, 14.dp)
            .clip(CircleShape)
            .background(colors.primaryBrush)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Add, null, tint = colors.accentInk, modifier = Modifier.size(20.dp))
        Text("新建任务", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = colors.accentInk)
    }
}
