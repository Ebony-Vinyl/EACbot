package com.eacbot.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.AgentDescriptor
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.ChoiceRow
import com.eacbot.mobile.ui.Gap
import com.eacbot.mobile.ui.GroupCard
import com.eacbot.mobile.ui.GroupLabel
import com.eacbot.mobile.ui.GroupTextField
import com.eacbot.mobile.ui.NoticeBanner
import com.eacbot.mobile.ui.PageHeader
import com.eacbot.mobile.ui.PrimaryButton
import com.eacbot.mobile.ui.StatusTone

/**
 * Starting a task.
 *
 * The engine list comes from the core, and its model list is what the engine
 * itself reported. When the engine reports no catalog, the screen says
 * "unknown" and sends no model rather than inventing one: a wrong model name
 * fails at native start, which is worse than an honest gap.
 */
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

    val ready = !state.creating && title.isNotBlank() && prompt.isNotBlank() &&
        state.selectedAgent != null && state.selectedEnvironment != null

    Column(Modifier.fillMaxSize().background(colors.canvasGrouped).imePadding()) {
        PageHeader(title = "新建任务", onBack = onBack)
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState()),
        ) {
            GroupLabel("你想完成什么")
            GroupCard {
                GroupTextField(
                    label = "任务主题",
                    value = title,
                    onValueChange = { title = it },
                    placeholder = "例如：整理本周的周报",
                    divider = true,
                )
                GroupTextField(
                    label = "具体要求",
                    value = prompt,
                    onValueChange = { prompt = it },
                    placeholder = "告诉智能体要做什么、做到什么程度",
                    singleLine = false,
                    minLines = 5,
                )
            }

            GroupLabel("引擎")
            if (state.loadingAgents) {
                CircularProgressIndicator(Modifier.padding(horizontal = 28.dp).size(22.dp), strokeWidth = 2.dp, color = colors.accent)
            } else if (state.agents.isEmpty()) {
                Hint("暂无可用引擎，请先在电脑上配置。", colors.attention)
            } else {
                ChoiceRow(
                    options = state.agents.map { it.rawKind },
                    selected = state.selectedAgent,
                    label = { kind -> state.agents.firstOrNull { it.rawKind == kind }?.label ?: kind },
                    onSelect = viewModel::selectAgent,
                )
            }
            state.selectedAgentDescriptor?.let { agent ->
                Gap(8.dp)
                CapabilitySummary(agent)
            }

            GroupLabel("模型")
            val models = state.models
            when {
                state.loadingModels -> Hint("正在读取引擎模型列表…")
                models == null -> Hint("未知：此引擎未提供模型列表。", colors.attention)
                models.reported -> {
                    val options = listOf<String?>(null) + models.models.take(8).map { it.ref.model }
                    ChoiceRow(
                        options = options,
                        selected = state.selectedModel,
                        label = { id -> if (id == null) "引擎默认" else models.models.first { it.ref.model == id }.ref.display },
                        onSelect = viewModel::selectModel,
                    )
                }
                else -> Hint("未知：此引擎本次未提供模型。", colors.attention)
            }

            GroupLabel("在哪台电脑上运行")
            if (state.environments.isEmpty()) {
                NoticeBanner("此服务尚未配置电脑。请先在桌面端添加，否则任务启动会失败。", tone = StatusTone.Failed)
            } else {
                ChoiceRow(
                    options = state.environments,
                    selected = state.selectedEnvironment,
                    label = { it.label },
                    onSelect = viewModel::selectEnvironment,
                )
            }

            state.error?.let { message ->
                Gap(16.dp)
                NoticeBanner(message, tone = StatusTone.Failed)
            }
            Gap(32.dp)
        }
        PrimaryButton(
            text = "开始任务",
            onClick = { viewModel.create(title, prompt) },
            enabled = ready,
            busy = state.creating,
            busyText = "正在创建",
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = EacbotDimens.gutter, vertical = 12.dp),
        )
    }
}

@Composable
private fun Hint(text: String, color: androidx.compose.ui.graphics.Color? = null) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = color ?: LocalEacbotColors.current.inkMuted,
        modifier = Modifier.padding(horizontal = 28.dp),
    )
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

    Column(Modifier.padding(horizontal = 28.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (notes.isEmpty()) {
            Text("完全控制", style = MaterialTheme.typography.labelSmall, color = colors.success)
        } else {
            notes.forEach { note ->
                Text(note, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
            }
        }
    }
}
