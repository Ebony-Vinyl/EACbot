package com.eacbot.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.ConversationItem
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.Hairline
import com.eacbot.mobile.ui.StatusPill
import com.eacbot.mobile.ui.statusLabel

/**
 * One mission as a conversation.
 *
 * The list is the folded log: assistant text, tool cards, approval and question
 * cards, and thin run markers. Controls come from the mission's own status, so
 * a button the server would refuse is not offered.
 */
@OptIn(ExperimentalMaterial3Api::class)
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

    LaunchedEffect(Unit) { viewModel.start() }
    LaunchedEffect(Unit) {
        viewModel.liveHints.collect { viewModel.onNotification() }
    }
    LaunchedEffect(state.fold.items.size) {
        if (state.fold.items.isNotEmpty()) listState.animateScrollToItem(state.fold.items.lastIndex)
    }

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(mission?.title ?: title, maxLines = 1, style = MaterialTheme.typography.titleMedium)
                        mission?.let { m ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                StatusPill(m.status, compact = true)
                                Text(
                                    text = m.model?.display ?: m.rawAgent,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.inkMuted,
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = onOpenComputer) {
                        Icon(Icons.Filled.Computer, contentDescription = "This task's computer")
                    }
                    if (operations != null) {
                        if (operations.steer || operations.interrupt) {
                            IconButton(onClick = { viewModel.interrupt() }, enabled = !state.sending) {
                                Icon(Icons.Filled.PauseCircle, contentDescription = "Pause this run")
                            }
                        }
                        if (operations.resume) {
                            IconButton(onClick = { viewModel.resume() }, enabled = !state.sending) {
                                Icon(Icons.Filled.PlayCircle, contentDescription = "Resume")
                            }
                        }
                        if (operations.cancel) {
                            IconButton(onClick = { viewModel.cancel() }, enabled = !state.sending) {
                                Icon(Icons.Filled.StopCircle, contentDescription = "Cancel this mission")
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.canvas, titleContentColor = colors.ink),
            )
        },
        bottomBar = {
            Composer(
                state = state,
                onDraftChange = viewModel::onDraftChange,
                onSend = viewModel::send,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }
                state.error != null && state.mission == null -> Column(
                    Modifier.fillMaxSize().padding(EacbotDimens.gutterWide),
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("Couldn't open this mission", style = MaterialTheme.typography.titleMedium, color = colors.ink)
                    Spacer(Modifier.height(6.dp))
                    Text(state.error!!, style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted)
                    Spacer(Modifier.height(12.dp))
                    TextButton(onClick = viewModel::retry) { Text("Try again") }
                }
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        horizontal = EacbotDimens.gutter,
                        vertical = 12.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (state.resyncing) {
                        item(key = "resync") {
                            Text(
                                "Catching up on missed events",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.attention,
                            )
                        }
                    }
                    if (state.offline) {
                        item(key = "offline") {
                            Text(
                                "Offline. Showing the last state this phone saw.",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.inkMuted,
                            )
                        }
                    }
                    items(state.fold.items, key = { "${it::class.simpleName}-${it.seq}" }) { item ->
                        when (item) {
                            is ConversationItem.AssistantText -> TextBubble(item.text, fromAgent = true)
                            is ConversationItem.StreamText -> TextBubble(item.text, fromAgent = false)
                            is ConversationItem.ToolCard -> ToolCard(item)
                            is ConversationItem.ApprovalCard -> ApprovalCard(
                                item = item,
                                busy = state.sending,
                                onResolve = { decision, answer -> viewModel.resolveApproval(item.approvalId, decision, answer) },
                            )
                            is ConversationItem.QuestionCard -> QuestionCard(
                                item = item,
                                busy = state.sending,
                                onAnswer = viewModel::answerQuestion,
                            )
                            is ConversationItem.RunMarker -> RunMarkerLine(item.kind, item.detail)
                            is ConversationItem.ArtifactCard -> ArtifactLine(item)
                            is ConversationItem.UsageLine -> UsageLine(item)
                        }
                    }
                    item(key = "tail") { Spacer(Modifier.height(8.dp)) }
                }
            }
        }
    }
}

@Composable
private fun ArtifactLine(item: ConversationItem.ArtifactCard) {
    val colors = LocalEacbotColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Artifact", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
        Text(item.path, style = MaterialTheme.typography.bodySmall, color = colors.ink, maxLines = 1)
        Text("${item.bytes} bytes", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
    }
}

@Composable
private fun UsageLine(item: ConversationItem.UsageLine) {
    val colors = LocalEacbotColors.current
    val parts = buildList {
        item.inputTokens?.let { add("$it in") }
        item.outputTokens?.let { add("$it out") }
        item.costUsd?.let { add("$${String.format("%.2f", it)}") }
    }
    if (parts.isEmpty()) return
    Text(parts.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
}

/**
 * The input row.
 *
 * While the agent is waiting on a question, the same field becomes the answer,
 * because that is the one thing a person wants to do next.
 */
@Composable
private fun Composer(
    state: ChatUiState,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    val colors = LocalEacbotColors.current
    val waiting = state.mission?.status == com.eacbot.mobile.core.MissionStatus.WaitingInput
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.surface)
            .navigationBarsPadding()
            .imePadding(),
    ) {
        Hairline()
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = state.draft,
                onValueChange = onDraftChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text(if (waiting) "Answer the agent" else "Message Hermes") },
                maxLines = 5,
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
            )
            IconButton(
                onClick = onSend,
                enabled = !state.sending && state.draft.isNotBlank(),
            ) {
                if (state.sending) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = colors.accent)
                } else {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = if (state.draft.isNotBlank()) colors.accent else colors.inkMuted,
                    )
                }
            }
        }
        state.error?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.labelSmall,
                color = colors.danger,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        val status = state.mission?.status
        if (status != null && status.isTerminal) {
            Text(
                text = statusLabel(status),
                style = MaterialTheme.typography.labelSmall,
                color = colors.inkMuted,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        Spacer(Modifier.width(1.dp))
    }
}
