package com.eacbot.mobile.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.core.ConversationItem
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.design.LocalReducedMotion
import com.eacbot.mobile.ui.CaptionChip
import com.eacbot.mobile.ui.IconTile
import com.eacbot.mobile.ui.PrimaryButton
import com.eacbot.mobile.ui.SecondaryButton

/** A grey rounded container that groups a header row with its content. */
@Composable
private fun CardShell(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = LocalEacbotColors.current
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(EacbotDimens.cardRadius))
            .background(colors.bubbleAgent)
            .padding(14.dp),
    ) { content() }
}

@Composable
private fun CardHeader(icon: ImageVector, title: String, subtitle: String?, tint: Color, tileColor: Color, trailing: @Composable () -> Unit = {}) {
    val colors = LocalEacbotColors.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        IconTile(icon, tint = tint, background = tileColor, size = 40.dp)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) {
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = colors.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        trailing()
    }
}

@Composable
private fun CodeBlock(text: String, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
        color = colors.ink,
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.surface)
            .horizontalScroll(rememberScrollState())
            .padding(12.dp),
    )
}

/**
 * A tool call and its result as one card. It starts collapsed because most
 * calls are noise; the outcome is always visible so a failed call never looks
 * like a successful one.
 */
@Composable
fun ToolCard(item: ConversationItem.ToolCard, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    var open by remember(item.callId) { mutableStateOf(false) }
    val reduced = LocalReducedMotion.current
    val (subtitle, tint) = when (item.ok) {
        true -> "已完成" to colors.success
        false -> "失败" to colors.danger
        null -> "运行中…" to colors.accent
    }
    CardShell(modifier.clickable(role = Role.Button) { open = !open }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            CardHeader(
                icon = if (item.tool.contains("bash", true) || item.tool.contains("shell", true)) Icons.Filled.Terminal else Icons.Filled.Build,
                title = item.tool,
                subtitle = subtitle,
                tint = colors.accent,
                tileColor = colors.accentSoft,
            ) {
                when (item.ok) {
                    true -> Icon(Icons.Filled.CheckCircle, null, tint = tint, modifier = Modifier.size(20.dp))
                    false -> Icon(Icons.Filled.ErrorOutline, null, tint = tint, modifier = Modifier.size(20.dp))
                    null -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = tint)
                }
                Icon(
                    if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = if (open) "隐藏详情" else "显示详情",
                    tint = colors.inkMuted,
                    modifier = Modifier.size(22.dp),
                )
            }
            if (!open && item.input.isNotEmpty()) {
                Text(
                    item.input.lineSequence().first().take(120),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = colors.inkMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            AnimatedVisibility(
                visible = open,
                enter = if (reduced) EnterTransition.None else expandVertically(),
                exit = if (reduced) ExitTransition.None else shrinkVertically(),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (item.input.isNotEmpty()) {
                        Text("输入", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                        CodeBlock(item.input)
                    }
                    item.output?.let { output ->
                        Text("结果", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                        CodeBlock(output)
                    }
                }
            }
        }
    }
}

/**
 * An approval, with the decisions a person actually makes. Denying refuses
 * this one request; the card says the agent continues without it.
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
    val reduced = LocalReducedMotion.current

    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(EacbotDimens.cardRadius))
            .background(colors.surface)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CardHeader(
            icon = Icons.Filled.Shield,
            title = "需要你决定",
            subtitle = item.action,
            tint = colors.attention,
            tileColor = colors.attentionSoft,
        )
        if (item.detail.isNotBlank()) CodeBlock(item.detail, Modifier.background(colors.surfaceRaised))
        item.expiresAt?.let {
            Text("到期时间：$it", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
        }
        if (item.isPending) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton("拒绝", { onResolve("deny", null) }, Modifier.weight(1f), enabled = !busy)
                PrimaryButton("允许", { onResolve("allow", null) }, Modifier.weight(1f), enabled = !busy)
            }
            Text(
                if (answering) "收起回答" else "改为回答",
                style = MaterialTheme.typography.labelLarge,
                color = colors.accent,
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .clip(CircleShape)
                    .clickable(enabled = !busy, role = Role.Button) { answering = !answering }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
            AnimatedVisibility(
                visible = answering,
                enter = if (reduced) EnterTransition.None else expandVertically(),
                exit = if (reduced) ExitTransition.None else shrinkVertically(),
            ) {
                AnswerBox(answer, { answer = it }, busy) { onResolve("answer", answer.trim()) }
            }
        } else {
            Text(
                when (item.decision) {
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
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(EacbotDimens.cardRadius))
            .background(colors.surface)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CardHeader(Icons.Filled.HelpOutline, "智能体在提问", null, colors.accent, colors.accentSoft)
        Text(item.question, style = MaterialTheme.typography.bodyLarge, color = colors.ink)
        if (item.isPending) {
            AnswerBox(answer, { answer = it }, busy) { onAnswer(answer.trim()) }
        } else {
            Text("你的回答：${item.answer}", style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted)
        }
    }
}

@Composable
private fun AnswerBox(value: String, onChange: (String) -> Unit, busy: Boolean, onSend: () -> Unit) {
    val colors = LocalEacbotColors.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        BasicTextField(
            value = value,
            onValueChange = onChange,
            enabled = !busy,
            minLines = 2,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.ink),
            cursorBrush = SolidColor(colors.accent),
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .background(colors.surfaceRaised)
                .padding(14.dp)
                .semantics { contentDescription = "你的回答" },
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text("你的回答", style = MaterialTheme.typography.bodyLarge, color = colors.inkFaint)
                    inner()
                }
            },
        )
        PrimaryButton("发送回答", onSend, Modifier.fillMaxWidth(), enabled = !busy && value.isNotBlank())
    }
}

/** Program output, kept apart from what the agent said. */
@Composable
fun OutputCard(text: String, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        fontFamily = FontFamily.Monospace,
        color = colors.inkMuted,
        modifier = modifier
            .heightIn(max = 260.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(colors.code)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    )
}

@Composable
fun ArtifactCard(item: ConversationItem.ArtifactCard, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Row(
        modifier
            .fillMaxWidth()
            .padding(end = 40.dp)
            .clip(RoundedCornerShape(EacbotDimens.cardRadius))
            .background(colors.bubbleAgent)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconTile(Icons.Filled.Description, tint = colors.accentInk, background = colors.accent, size = 40.dp)
        Column(Modifier.weight(1f)) {
            Text(
                item.path.substringAfterLast('/'),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${item.path.substringAfterLast('.', "文件").uppercase()} · ${formatBytes(item.bytes)}",
                style = MaterialTheme.typography.bodySmall,
                color = colors.inkMuted,
            )
        }
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1_048_576 -> String.format("%.1f MB", bytes / 1_048_576.0)
    bytes >= 1024 -> String.format("%.1f KB", bytes / 1024.0)
    else -> "$bytes 字节"
}

/** A run boundary reads as an event, not as something the agent said. */
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
        "completed" -> colors.success
        else -> colors.inkMuted
    }
    CaptionChip(if (detail.isNullOrBlank()) label else "$label · $detail", modifier, tint)
}
