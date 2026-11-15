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
                title = { Text("New task", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
                label = { Text("What is it about") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
            )
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                label = { Text("What should Hermes do") },
                minLines = 5,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
            )

            SectionLabel("Engine")
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

            SectionLabel("Model")
            when {
                state.loadingModels -> Text("Reading the engine's catalog…", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
                state.models == null -> Text(
                    "Unknown: this engine did not report a model list.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.attention,
                )
                state.models!!.reported -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = state.selectedModel == null,
                            onClick = { viewModel.selectModel(null) },
                            label = { Text("Engine default") },
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
                    "Unknown: this engine reported no models this time.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.attention,
                )
            }

            SectionLabel("Computer")
            if (state.environments.isEmpty()) {
                Text(
                    "No computer is configured on this core. The task will fail at start until one is added on the desktop.",
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
                    Text("Start task")
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
                    is com.eacbot.mobile.core.SteerCapability.None -> "No mid-task messages: ${steer.reason}"
                    is com.eacbot.mobile.core.SteerCapability.NextBoundary -> "Messages land at the next step: ${steer.note}"
                    else -> ""
                },
            )
        }
        if (!agent.capabilities.interrupt) add("Cannot pause")
        if (!agent.capabilities.resume) add("Cannot resume a paused run")
        if (!agent.capabilities.approval) add("No approval prompts")
        if (!agent.capabilities.questions) add("No questions")
        if (!agent.capabilities.modelCatalog) add("Reports no model list")
    }.filter { it.isNotEmpty() }

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (notes.isEmpty()) {
            Text("Full control", style = MaterialTheme.typography.labelSmall, color = colors.success)
        } else {
            notes.forEach { note ->
                Text(note, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
            }
        }
    }
}
