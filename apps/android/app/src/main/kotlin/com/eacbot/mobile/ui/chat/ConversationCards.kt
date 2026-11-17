package com.eacbot.mobile.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.core.ConversationItem
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.design.LocalReducedMotion

/**
 * A tool call and its result as one card.
 *
 * The tool's input is not decoration: a person approving a write needs to see
 * the path. It starts collapsed because most calls are noise, and the outcome
 * is always visible so a failed call never looks like a successful one.
 */
@Composable
fun ToolCard(item: ConversationItem.ToolCard, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    var open by remember(item.callId) { mutableStateOf(false) }
    val reduced = LocalReducedMotion.current
    val shape = RoundedCornerShape(EacbotDimens.controlRadius)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.surfaceRaised, shape)
            .border(EacbotDimens.hairline, colors.outline, shape)
            .clickable { open = !open }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = item.tool,
                style = MaterialTheme.typography.labelMedium,
                color = colors.ink,
                modifier = Modifier.weight(1f),
            )
            OutcomeLabel(item.ok)
            Icon(
                imageVector = if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                contentDescription = if (open) "隐藏详情" else "显示详情",
                tint = colors.inkMuted,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) {
            if (item.input.isNotEmpty()) {
                Text("输入", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(
                    text = item.input,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = colors.ink,
                )
            }
            val output = item.output
            if (output != null) {
                Text("结果", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                Text(
                    text = output,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = colors.ink,
                )
            }
        } else if (item.input.isNotEmpty()) {
            Text(
                text = item.input.lineSequence().first().take(120),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = colors.inkMuted,
            )
        }
    }
}

@Composable
private fun OutcomeLabel(ok: Boolean?) {
    val colors = LocalEacbotColors.current
    val (text, tint) = when (ok) {
        true -> "ok" to colors.success
        false -> "failed" to colors.danger
        null -> "running" to colors.inkMuted
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = tint)
}

/**
 * An approval, with the two decisions a person actually makes.
 *
 * `deny` and `skip` are different actions and read differently: denying refuses
 * this one request, and the card says the agent will continue without it.
 */
@Composable
fun ApprovalCard(
    item: ConversationItem.ApprovalCard,
    busy: Boolean,
    onResolve: (decision: String, answer: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalEacbotColors.current
    var answer by remember(item.approvalId) { mutableStateOf("") }
    var answering by remember(item.approvalId) { mutableStateOf(false) }
    val shape = RoundedCornerShape(EacbotDimens.cardRadius)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.surface, shape)
            .border(1.dp, colors.attention, shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("需要你决定", style = MaterialTheme.typography.labelMedium, color = colors.attention)
        Text(item.action, style = MaterialTheme.typography.titleSmall, color = colors.ink)
        Text(
            text = item.detail,
            style = MaterialTheme.typography.bodyMedium,
            fontFamily = FontFamily.Monospace,
            color = colors.inkMuted,
        )
        item.expiresAt?.let {
            Text("到期时间：$it", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
        }

        if (item.isPending) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onResolve("allow", null) },
                    enabled = !busy,
                    shape = RoundedCornerShape(EacbotDimens.controlRadius),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
                ) { Text("允许") }
                OutlinedButton(
                    onClick = { onResolve("deny", null) },
                    enabled = !busy,
                    shape = RoundedCornerShape(EacbotDimens.controlRadius),
                ) { Text("拒绝") }
                TextButton(onClick = { answering = !answering }, enabled = !busy) { Text("改为回答") }
            }
            AnimatedVisibility(
                visible = answering,
                enter = if (LocalReducedMotion.current) androidx.compose.animation.EnterTransition.None else expandVertically(),
                exit = if (LocalReducedMotion.current) androidx.compose.animation.ExitTransition.None else shrinkVertically(),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = answer,
                        onValueChange = { answer = it },
                        label = { Text("你的回答") },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(EacbotDimens.controlRadius),
                    )
                    Button(
                        onClick = { onResolve("answer", answer.trim()) },
                        enabled = !busy && answer.isNotBlank(),
                        shape = RoundedCornerShape(EacbotDimens.controlRadius),
                        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
                    ) { Text("发送回答") }
                }
            }
        } else {
            Text(
                text = when (item.decision) {
                    "allow" -> "已允许${item.decidedBy?.let { "，由 $it 批准" } ?: ""}"
                    "deny" -> "已拒绝，智能体将跳过此操作继续。"
                    "expired" -> "未决定便已过期"
                    else -> item.decision ?: ""
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (item.decision == "deny") colors.danger else colors.inkMuted,
            )
        }
    }
}

/** A question the agent asked and is blocked on. */
@Composable
fun QuestionCard(
    item: ConversationItem.QuestionCard,
    busy: Boolean,
    onAnswer: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalEacbotColors.current
    var answer by remember(item.seq) { mutableStateOf("") }
    val shape = RoundedCornerShape(EacbotDimens.cardRadius)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.surface, shape)
            .border(1.dp, colors.attention, shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("提问", style = MaterialTheme.typography.labelMedium, color = colors.attention)
        Text(item.question, style = MaterialTheme.typography.bodyLarge, color = colors.ink)
        if (item.isPending) {
            OutlinedTextField(
                value = answer,
                onValueChange = { answer = it },
                label = { Text("你的回答") },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
            )
            Button(
                onClick = { onAnswer(answer.trim()) },
                enabled = !busy && answer.isNotBlank(),
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
            ) { Text("发送回答") }
        } else {
            Text("你的回答：${item.answer}", style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted)
        }
    }
}

/** The agent's own text, or a line of program output kept apart from it. */
@Composable
fun TextBubble(text: String, fromAgent: Boolean, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    val shape = RoundedCornerShape(EacbotDimens.cardRadius)
    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge,
        color = if (fromAgent) colors.ink else colors.inkMuted,
        modifier = modifier
            .fillMaxWidth()
            .background(if (fromAgent) colors.surface else colors.code, shape)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    )
}

/** A run boundary: started, completed, failed, cancelled. It is a thin line so
 * it reads as an event, not as something the agent said. */
@Composable
fun RunMarkerLine(kind: String, detail: String?, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    val label = when (kind) {
        "started" -> "已开始"
        "completed" -> "已完成"
        "failed" -> "失败"
        "cancelled" -> "已取消"
        "interrupted" -> "已暂停"
        "resumed" -> "已恢复"
        else -> kind
    }
    val tint = when (kind) {
        "failed" -> colors.danger
        "cancelled" -> colors.inkMuted
        "completed" -> colors.success
        else -> colors.inkMuted
    }
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = tint)
        if (!detail.isNullOrBlank()) {
            Text(
                text = "· $detail",
                style = MaterialTheme.typography.labelSmall,
                color = colors.inkMuted,
                maxLines = 2,
            )
        }
    }
}
