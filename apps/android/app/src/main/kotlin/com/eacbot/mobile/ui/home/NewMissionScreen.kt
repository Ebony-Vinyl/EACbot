package com.eacbot.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.AgentDescriptor
import com.eacbot.mobile.core.AgentKind
import com.eacbot.mobile.core.AgentModels
import com.eacbot.mobile.core.EnvironmentRef
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.SectionLabel

/**
 * Starting a task.
 *
 * The engine list comes from the core, and its model list is what the engine
 * itself reported. When the engine reports no catalog, the screen says
 * "unknown" and sends no model rather than inventing one: a wrong model name
 * fails at native start, which is worse than an honest gap.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewMissionScreen(
    viewModel: NewMissionViewModel,
    onBack: () -> Unit,
    onCreated: (missionId: String) -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val colors = LocalEacbotColors.current
    var title by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }

    LaunchedEffect(state.createdMissionId) {
        state.createdMissionId?.let(onCreated)
    }

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            TopAppBar(
                title = { Text("新建任务", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.canvas, titleContentColor = colors.ink),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = EacbotDimens.gutterWide, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text("任务主题") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
            )
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                label = { Text("希望 Hermes 做什么") },
                minLines = 5,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
            )

            SectionLabel("引擎")
            if (state.loadingAgents) {
                CircularProgressIndicator(color = colors.accent, modifier = Modifier.height(24.dp))
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    state.agents.forEach { agent ->
                        FilterChip(
                            selected = state.selectedAgent == agent.rawKind,
                            onClick = { viewModel.selectAgent(agent.rawKind) },
                            label = { Text(agent.label, style = MaterialTheme.typography.labelMedium) },
                        )
                    }
                }
            }
            state.selectedAgentDescriptor?.let { agent ->
                CapabilitySummary(agent)
            }

            SectionLabel("模型")
            when {
                state.loadingModels -> Text("正在读取引擎模型列表…", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
                state.models == null -> Text(
                    "未知：此引擎未提供模型列表。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.attention,
                )
                state.models!!.reported -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = state.selectedModel == null,
                            onClick = { viewModel.selectModel(null) },
                            label = { Text("引擎默认模型") },
                        )
                        state.models!!.models.take(6).forEach { entry ->
                            FilterChip(
                                selected = state.selectedModel == entry.ref.model,
                                onClick = { viewModel.selectModel(entry.ref.model) },
                                label = { Text(entry.ref.display, style = MaterialTheme.typography.labelMedium) },
                            )
                        }
                    }
                }
                else -> Text(
                    "未知：此引擎本次未提供模型。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.attention,
                )
            }

            SectionLabel("电脑")
            if (state.environments.isEmpty()) {
                Text(
                    "此服务尚未配置电脑。请先在桌面端添加，否则任务启动会失败。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.danger,
                )
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    state.environments.forEach { environment ->
                        FilterChip(
                            selected = state.selectedEnvironment?.id == environment.id,
                            onClick = { viewModel.selectEnvironment(environment) },
                            label = { Text(environment.label, style = MaterialTheme.typography.labelMedium) },
                        )
                    }
                }
            }

            state.error?.let { message ->
                Text(message, style = MaterialTheme.typography.bodyMedium, color = colors.danger)
            }

            Spacer(Modifier.height(4.dp))
            Button(
                onClick = { viewModel.create(title, prompt) },
                enabled = !state.creating &&
                    title.isNotBlank() &&
                    prompt.isNotBlank() &&
                    state.selectedAgent != null &&
                    state.selectedEnvironment != null,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
            ) {
                if (state.creating) {
                    CircularProgressIndicator(modifier = Modifier.height(20.dp), strokeWidth = 2.dp, color = colors.accentInk)
                } else {
                    Text("开始任务")
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** What the chosen engine can and cannot do, stated before the person starts. */
@Composable
private fun CapabilitySummary(agent: AgentDescriptor) {
    val colors = LocalEacbotColors.current
    val notes = buildList {
        if (!agent.capabilities.canSteer) {
            add(
                when (val steer = agent.capabilities.steer) {
                    is com.eacbot.mobile.core.SteerCapability.None -> "不支持运行中发送消息：${steer.reason}"
                    is com.eacbot.mobile.core.SteerCapability.NextBoundary -> "消息将在下一步送达：${steer.note}"
                    else -> ""
                },
            )
        }
        if (!agent.capabilities.interrupt) add("不支持暂停")
        if (!agent.capabilities.resume) add("无法恢复已暂停运行")
        if (!agent.capabilities.approval) add("无审批提示")
        if (!agent.capabilities.questions) add("无提问")
        if (!agent.capabilities.modelCatalog) add("未提供模型列表")
    }.filter { it.isNotEmpty() }

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (notes.isEmpty()) {
            Text("完全控制", style = MaterialTheme.typography.labelSmall, color = colors.success)
        } else {
            notes.forEach { note ->
                Text(note, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
            }
        }
    }
}
