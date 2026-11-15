package com.eacbot.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.Mission
import com.eacbot.mobile.core.MissionFilter
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.design.enterAnimation
import com.eacbot.mobile.ui.EmptyNote
import com.eacbot.mobile.ui.StatusPill
import com.eacbot.mobile.ui.statusLabel

/**
 * The phone's first screen: the bots (missions) this core is running.
 *
 * A phone shows one list and one conversation, not the desktop's three panes.
 * Each row carries the four states that do not compete: working, needs you,
 * finished, failed. "Needs you" wins over unread because it is the only one
 * that blocks someone else.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
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
    val all = missions.values.toList()
    val filtered = all
        .filter { filter.matches(it.status) }
        .sortedWith(
            compareBy<Mission>(
                { if (it.status == MissionStatus.WaitingInput) 0 else if (it.status == MissionStatus.WaitingChildren) 1 else 2 },
                { -it.revision },
            ),
        )

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Hermes", style = MaterialTheme.typography.titleLarge, color = colors.ink)
                        Text(
                            text = when {
                                offlineNote != null -> offlineNote
                                streamConnected -> "Live"
                                else -> "Reconnecting"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (offlineNote != null) colors.danger else colors.inkMuted,
                        )
                    }
                },
                actions = {
                    TextAction("Agents", onOpenAgents)
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings and devices", tint = colors.ink)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.canvas),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onCreate,
                containerColor = colors.accent,
                contentColor = colors.accentInk,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New task") },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).safeDrawingPadding()) {
            TabRow(
                selectedTabIndex = filter.ordinal,
                containerColor = colors.canvas,
                contentColor = colors.accent,
            ) {
                MissionFilter.entries.forEach { option ->
                    Tab(
                        selected = filter == option,
                        onClick = { filter = option },
                        text = {
                            Text(
                                option.label,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (filter == option) colors.ink else colors.inkMuted,
                            )
                        },
                    )
                }
            }

            if (filtered.isEmpty()) {
                EmptyNote(
                    title = when {
                        all.isEmpty() -> "No tasks yet"
                        else -> "Nothing ${filter.label.lowercase()}"
                    },
                    detail = when {
                        all.isEmpty() -> "Start one and Hermes will run it on your computer."
                        else -> "Switch to All to see every task this core holds."
                    },
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = EacbotDimens.gutter,
                        end = EacbotDimens.gutter,
                        top = 8.dp,
                        bottom = 96.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(filtered, key = { it.id }) { mission ->
                        MissionRow(mission) { onOpenMission(mission.id) }
                    }
                }
            }
        }
    }
}

@Composable
private fun MissionRow(mission: Mission, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    val shape = RoundedCornerShape(EacbotDimens.cardRadius)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .enterAnimation(mission.id)
            .background(colors.surface, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = mission.title.ifBlank { "Untitled task" },
                style = MaterialTheme.typography.titleSmall,
                color = colors.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusPill(mission.status, compact = true)
                Text(
                    text = mission.model?.display ?: mission.rawAgent,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.inkMuted,
                    maxLines = 1,
                )
            }
            if (mission.status == MissionStatus.WaitingInput) {
                Text(
                    text = "Waiting for you before it continues",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.attention,
                )
            }
        }
        Text(
            text = statusLabel(mission.status),
            style = MaterialTheme.typography.labelSmall,
            color = colors.inkMuted,
        )
    }
}

@Composable
private fun TextAction(label: String, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    Box(
        Modifier
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = colors.accent)
    }
}
