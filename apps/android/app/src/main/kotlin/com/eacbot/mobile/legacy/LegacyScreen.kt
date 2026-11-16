package com.eacbot.mobile.legacy

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.eacbot.mobile.ui.PairingScreen
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
        PairingScreen(defaultLabel = "Android", notice = state.error,
            onPair = viewModel::pair, heading = "连接 EACbot", description = "填写开发后端地址和设备配对码，访问已有机器人。")
        return
    }
    val list = rememberLazyListState()
    LaunchedEffect(state.messages.lastOrNull()?.id, state.messages.lastOrNull()?.text) {
        if (state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.lastIndex)
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            if (state.selected != null) TextButton(onClick = { viewModel.select(null) }) { Text("返回") }
            Text(state.selected?.name ?: "我的机器人", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 12.dp))
            if (state.selected == null) TextButton(onClick = viewModel::logout) { Text("退出登录") }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        state.connectionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (state.selected == null) {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.bots, key = { it.id }) { bot ->
                    Card(onClick = { viewModel.select(bot) }, modifier = Modifier.fillMaxWidth()) {
                        Text(bot.name, Modifier.padding(20.dp), style = MaterialTheme.typography.titleMedium)
                    }
                }
                if (state.bots.isEmpty()) item { Text("暂无机器人") }
            }
        } else {
            LazyColumn(Modifier.weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.messages, key = { it.id }) { message ->
                    Surface(color = if (message.role == "user") MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                        shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(if (message.role == "user") "你" else state.selected!!.name, style = MaterialTheme.typography.labelSmall)
                            Text(message.text.ifBlank { "[${message.kind}] 请在桌面端查看详情" })
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = state.draft, onValueChange = viewModel::draft,
                    modifier = Modifier.weight(1f), placeholder = { Text("发送消息") }, maxLines = 5,
                    enabled = !state.sending)
                Button(onClick = viewModel::send, enabled = !state.sending && state.draft.isNotBlank()) {
                    Text(if (state.sending) "发送中" else "发送")
                }
            }
        }
    }
}
