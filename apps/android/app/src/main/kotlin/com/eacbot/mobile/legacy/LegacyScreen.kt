package com.eacbot.mobile.legacy

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.eacbot.mobile.core.LegacyBot
import com.eacbot.mobile.core.LegacyMessage
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.AgentHeader
import com.eacbot.mobile.ui.CaptionChip
import com.eacbot.mobile.ui.ChatBubble
import com.eacbot.mobile.ui.CircleButton
import com.eacbot.mobile.ui.DisconnectedHome
import com.eacbot.mobile.ui.EmptyHero
import com.eacbot.mobile.ui.Gap
import com.eacbot.mobile.ui.GroupCard
import com.eacbot.mobile.ui.GroupLabel
import com.eacbot.mobile.ui.GroupRow
import com.eacbot.mobile.ui.InitialTile
import com.eacbot.mobile.ui.LargeTitle
import com.eacbot.mobile.ui.MenuButton
import com.eacbot.mobile.ui.MessageComposer
import com.eacbot.mobile.ui.NoticeBanner
import com.eacbot.mobile.ui.SearchField
import com.eacbot.mobile.ui.StatusTone
import com.eacbot.mobile.ui.TypingBubble
import kotlinx.coroutines.delay

@Composable
fun LegacyScreen(viewModel: LegacyViewModel) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(state.connected, state.selected, owner) {
        if (state.connected) owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { viewModel.refresh(); delay(2000) }
        }
    }
    BackHandler(state.selected != null) { viewModel.select(null) }
    if (!state.connected) {
        DisconnectedHome(
            title = "对话",
            defaultLabel = "Android",
            notice = state.error,
            onPair = viewModel::pair,
            draft = state.draft,
            onDraft = viewModel::draft,
        )
        return
    }
    val selected = state.selected
    if (selected == null) BotDirectory(state, viewModel) else Conversation(selected, state, viewModel)
}

@Composable
private fun BotDirectory(state: LegacyState, viewModel: LegacyViewModel) {
    val colors = LocalEacbotColors.current
    var search by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    val bots = state.bots.filter { it.name.contains(search, ignoreCase = true) }

    Column(Modifier.fillMaxSize().background(colors.canvasGrouped)) {
        AgentHeader(
            name = "EACbot",
            status = state.connectionError ?: "已连接电脑",
            statusColor = if (state.connectionError != null) colors.attention else colors.success,
            leading = { MenuButton() },
            trailing = {
                Box {
                    CircleButton(Icons.Filled.MoreHoriz, "更多", { menuOpen = true })
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("退出登录") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                            onClick = {
                                menuOpen = false
                                viewModel.logout()
                            },
                        )
                    }
                }
            },
        )
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item { LargeTitle("助手") }
            item { SearchField(search, { search = it }, "搜索助手") }
            state.error?.let { message -> item { Gap(12.dp); NoticeBanner(message, tone = StatusTone.Failed) } }
            if (bots.isEmpty()) {
                item {
                    EmptyHero(
                        title = if (search.isBlank()) "还没有助手" else "没有找到“$search”",
                        detail = if (search.isBlank()) "在电脑端添加助手后，就能在这里和它对话。" else "试试其他名称。",
                        modifier = Modifier.padding(top = 32.dp),
                    )
                }
            } else {
                item { GroupLabel("全部助手 · ${bots.size}") }
                item {
                    GroupCard {
                        bots.forEachIndexed { index, bot ->
                            GroupRow(
                                title = bot.name,
                                subtitle = "点按开始对话",
                                leading = { InitialTile(bot.name) },
                                divider = index < bots.lastIndex,
                                onClick = { viewModel.select(bot) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Conversation(bot: LegacyBot, state: LegacyState, viewModel: LegacyViewModel) {
    val colors = LocalEacbotColors.current
    val list = rememberLazyListState()
    val waiting = state.sending || state.messages.lastOrNull()?.role == "user"
    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.text, waiting) {
        val count = state.messages.size + if (waiting) 1 else 0
        if (count > 0) list.animateScrollToItem(count - 1)
    }

    Column(Modifier.fillMaxSize().background(colors.canvas).imePadding()) {
        AgentHeader(
            name = bot.name,
            status = when {
                state.connectionError != null -> state.connectionError
                waiting -> "正在处理…"
                else -> null
            },
            statusColor = if (state.connectionError != null) colors.attention else colors.inkMuted,
            leading = { CircleButton(Icons.AutoMirrored.Filled.ArrowBack, "返回助手列表", { viewModel.select(null) }) },
        )
        Box(Modifier.weight(1f)) {
            if (state.messages.isEmpty() && !waiting) {
                EmptyHero(
                    title = "和 ${bot.name} 聊聊",
                    detail = "告诉它你想完成什么，它会在你的电脑上处理。",
                    modifier = Modifier.align(Alignment.Center),
                )
            }
            LazyColumn(
                Modifier.fillMaxSize(),
                state = list,
                contentPadding = PaddingValues(horizontal = EacbotDimens.gutter, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.messages, key = { it.id }) { message -> MessageRow(message) }
                if (waiting) item(key = "typing") { TypingBubble() }
            }
        }
        state.error?.let { NoticeBanner(it, tone = StatusTone.Failed) }
        MessageComposer(
            text = state.draft,
            change = viewModel::draft,
            send = viewModel::send,
            enabled = !state.sending,
            hint = "发消息给 ${bot.name}",
            modifier = Modifier.navigationBarsPadding(),
        )
    }
}

@Composable
private fun MessageRow(message: LegacyMessage) {
    if (message.text.isBlank()) {
        CaptionChip("[${message.kind}] 请在桌面端查看详情")
    } else {
        ChatBubble(message.text, fromUser = message.role == "user")
    }
}
