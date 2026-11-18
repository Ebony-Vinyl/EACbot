package com.eacbot.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.ConversationItem
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.AgentHeader
import com.eacbot.mobile.ui.CaptionChip
import com.eacbot.mobile.ui.ChatBubble
import com.eacbot.mobile.ui.CircleButton
import com.eacbot.mobile.ui.EmptyHero
import com.eacbot.mobile.ui.MessageComposer
import com.eacbot.mobile.ui.NoticeBanner
import com.eacbot.mobile.ui.StatusTone
import com.eacbot.mobile.ui.TypingBubble
import com.eacbot.mobile.ui.statusLabel
import com.eacbot.mobile.ui.statusTone

/**
 * One mission as a conversation: the folded log as bubbles and cards. Controls
 * come from the mission's own status, so a button the server would refuse is
 * not offered.
 */
@Composable
fun ChatScreen(
    title: String,
    viewModel: ChatViewModel,
    onBack: () -> Unit,
    onOpenComputer: () -> Unit = {},
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val colors = LocalEacbotColors.current
    val listState = rememberLazyListState()
    val mission = state.mission
    val operations = state.operations
    var menuOpen by remember { mutableStateOf(false) }
    val working = mission?.status?.let { statusTone(it) == StatusTone.Working } == true

    LaunchedEffect(Unit) { viewModel.start() }
    LaunchedEffect(Unit) { viewModel.liveHints.collect { viewModel.onNotification() } }
    LaunchedEffect(state.fold.items.size, working) {
        val count = state.fold.items.size + if (working) 1 else 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    Column(Modifier.fillMaxSize().background(colors.canvas).imePadding()) {
        AgentHeader(
            name = mission?.title?.ifBlank { null } ?: title,
            status = mission?.let { m ->
                listOfNotNull(statusLabel(m.status), m.model?.display).joinToString(" · ")
            },
            statusColor = mission?.let { statusTone(it.status).colors(colors).first },
            leading = { CircleButton(Icons.AutoMirrored.Filled.ArrowBack, "返回", onBack) },
            trailing = {
                Box {
                    CircleButton(Icons.Filled.MoreHoriz, "任务操作", { menuOpen = true })
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("此任务的电脑") },
                            leadingIcon = { Icon(Icons.Filled.Computer, null) },
                            onClick = { menuOpen = false; onOpenComputer() },
                        )
                        if (operations != null && (operations.steer || operations.interrupt)) {
                            DropdownMenuItem(
                                text = { Text("暂停此次运行") },
                                leadingIcon = { Icon(Icons.Filled.PauseCircle, null) },
                                enabled = !state.sending,
                                onClick = { menuOpen = false; viewModel.interrupt() },
                            )
                        }
                        if (operations?.resume == true) {
                            DropdownMenuItem(
                                text = { Text("恢复") },
                                leadingIcon = { Icon(Icons.Filled.PlayCircle, null) },
                                enabled = !state.sending,
                                onClick = { menuOpen = false; viewModel.resume() },
                            )
                        }
                        if (operations?.cancel == true) {
                            DropdownMenuItem(
                                text = { Text("取消此任务", color = colors.danger) },
                                leadingIcon = { Icon(Icons.Filled.StopCircle, null, tint = colors.danger) },
                                enabled = !state.sending,
                                onClick = { menuOpen = false; viewModel.cancel() },
                            )
                        }
                    }
                }
            },
        )

        Box(Modifier.weight(1f)) {
            when {
                state.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = colors.accent)
                state.error != null && mission == null -> EmptyHero(
                    title = "无法打开此任务",
                    detail = state.error!!,
                    action = "重试",
                    onAction = viewModel::retry,
                    modifier = Modifier.align(Alignment.Center),
                )
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = EacbotDimens.gutter, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (state.resyncing) item(key = "resync") { CaptionChip("正在补齐遗漏事件", color = colors.attention) }
                    if (state.offline) item(key = "offline") { CaptionChip("已离线，显示此手机最后收到的状态") }
                    mission?.prompt?.takeIf { it.isNotBlank() }?.let { prompt ->
                        item(key = "prompt") { ChatBubble(prompt, fromUser = true) }
                    }
                    items(state.fold.items, key = { "${it::class.simpleName}-${it.seq}" }) { item ->
                        when (item) {
                            is ConversationItem.AssistantText -> ChatBubble(item.text, fromUser = false)
                            is ConversationItem.StreamText -> OutputCard(item.text)
                            is ConversationItem.ToolCard -> ToolCard(item)
                            is ConversationItem.ApprovalCard -> ApprovalCard(
                                item = item,
                                busy = state.sending,
                                onResolve = { decision, answer -> viewModel.resolveApproval(item.approvalId, decision, answer) },
                            )
                            is ConversationItem.QuestionCard -> QuestionCard(item, state.sending, viewModel::answerQuestion)
                            is ConversationItem.RunMarker -> RunMarkerLine(item.kind, item.detail)
                            is ConversationItem.ArtifactCard -> ArtifactCard(item)
                            is ConversationItem.UsageLine -> UsageLine(item)
                        }
                    }
                    if (working) item(key = "typing") { TypingBubble() }
                }
            }
        }

        Composer(state, viewModel::onDraftChange, viewModel::send)
    }
}

@Composable
private fun UsageLine(item: ConversationItem.UsageLine) {
    val parts = buildList {
        item.inputTokens?.let { add("输入 $it") }
        item.outputTokens?.let { add("输出 $it") }
        item.costUsd?.let { add("$${String.format("%.2f", it)}") }
    }
    if (parts.isNotEmpty()) CaptionChip(parts.joinToString(" · "))
}

/** While the agent waits on a question, the same field becomes the answer. */
@Composable
private fun Composer(state: ChatUiState, onDraftChange: (String) -> Unit, onSend: () -> Unit) {
    val colors = LocalEacbotColors.current
    val status = state.mission?.status
    Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
        state.error?.let { message ->
            if (state.mission != null) NoticeBanner(message, tone = StatusTone.Failed)
        }
        if (status != null && status.isTerminal) {
            Text(
                "此任务${statusLabel(status)}，无法再发送消息",
                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                color = colors.inkMuted,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
        MessageComposer(
            text = state.draft,
            change = onDraftChange,
            send = onSend,
            enabled = state.canSend && !state.sending,
            hint = when {
                state.sending -> "发送中…"
                !state.canSend -> "当前任务无法接收消息"
                status == MissionStatus.WaitingInput -> "回答智能体"
                else -> "发送消息"
            },
        )
    }
}
