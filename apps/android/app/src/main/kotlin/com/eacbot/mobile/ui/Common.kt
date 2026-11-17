package com.eacbot.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.design.animatedProgress

/**
 * A status is always a dot *and* a word.
 *
 * Colour alone would fail for a person with a colour vision deficiency and for
 * anyone reading in bright light, and the four states a mission can be in are
 * the whole point of this screen.
 */
@Composable
fun StatusPill(
    status: MissionStatus,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val colors = LocalEacbotColors.current
    val tone = statusTone(status)
    val dotColor = when (tone) {
        Tone.Working -> colors.accent
        Tone.Waiting -> colors.attention
        Tone.Done -> colors.success
        Tone.Failed -> colors.danger
        Tone.Quiet -> colors.inkMuted
    }
    val progress = animatedProgress(if (tone == Tone.Working) 1f else 0f)

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(percent = 50))
            .background(colors.surfaceRaised)
            .border(EacbotDimens.hairline, colors.outline, RoundedCornerShape(percent = 50))
            .padding(horizontal = if (compact) 8.dp else 10.dp, vertical = 4.dp)
            .semantics { contentDescription = "状态：${statusLabel(status)}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .size(if (progress > 0.5f) 8.dp else 7.dp)
                .clip(CircleShape)
                .background(dotColor),
        )
        Text(
            text = statusLabel(status),
            style = MaterialTheme.typography.labelSmall,
            color = colors.inkMuted,
        )
    }
}

private enum class Tone { Working, Waiting, Done, Failed, Quiet }

private fun statusTone(status: MissionStatus): Tone = when (status) {
    MissionStatus.Running, MissionStatus.Resuming, MissionStatus.Provisioning, MissionStatus.Queued -> Tone.Working
    MissionStatus.WaitingInput, MissionStatus.WaitingChildren -> Tone.Waiting
    MissionStatus.Interrupted -> Tone.Waiting
    MissionStatus.Succeeded -> Tone.Done
    MissionStatus.Failed -> Tone.Failed
    MissionStatus.Cancelled -> Tone.Quiet
}

/** What a person reads. "等你处理" is the one that needs action. */
fun statusLabel(status: MissionStatus): String = when (status) {
    MissionStatus.Queued -> "排队中"
    MissionStatus.Provisioning -> "启动中"
    MissionStatus.Running -> "工作中"
    MissionStatus.WaitingInput -> "等待你处理"
    MissionStatus.WaitingChildren -> "等待协作助手"
    MissionStatus.Interrupted -> "已暂停"
    MissionStatus.Resuming -> "恢复中"
    MissionStatus.Succeeded -> "完成"
    MissionStatus.Failed -> "失败"
    MissionStatus.Cancelled -> "已取消"
}

/** A quiet section heading, used instead of a second toolbar. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = colors.inkMuted,
        modifier = modifier.padding(horizontal = 4.dp, vertical = 6.dp),
    )
}

/** A one-line empty state. It says what is missing and what to do, never
 * "暂无内容" on its own. */
@Composable
fun EmptyNote(title: String, detail: String, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Column(
        modifier = modifier.fillMaxWidth().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = colors.ink)
        Text(detail, style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted)
    }
}

/** A thin divider that matches the outline rather than Material's default. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Box(modifier.fillMaxWidth().height(EacbotDimens.hairline).background(colors.outline))
}

/** A labelled value a card shows, e.g. "模型 · Hermes 4". */
@Composable
fun MetaPair(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color? = null) {
    val colors = LocalEacbotColors.current
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
        Text(value, style = MaterialTheme.typography.labelSmall, color = valueColor ?: colors.ink)
    }
}
