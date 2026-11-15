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
            .semantics { contentDescription = "Status: ${statusLabel(status)}" },
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

/** What a person reads. "Waiting for you" is the one that needs action. */
fun statusLabel(status: MissionStatus): String = when (status) {
    MissionStatus.Queued -> "Queued"
    MissionStatus.Provisioning -> "Starting"
    MissionStatus.Running -> "Working"
    MissionStatus.WaitingInput -> "Needs you"
    MissionStatus.WaitingChildren -> "Waiting on helpers"
    MissionStatus.Interrupted -> "Paused"
    MissionStatus.Resuming -> "Resuming"
    MissionStatus.Succeeded -> "Done"
    MissionStatus.Failed -> "Failed"
    MissionStatus.Cancelled -> "Cancelled"
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
 * "nothing here yet" on its own. */
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

/** A labelled value a card shows, e.g. "Model · Hermes 4". */
@Composable
fun MetaPair(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color? = null) {
    val colors = LocalEacbotColors.current
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
        Text(value, style = MaterialTheme.typography.labelSmall, color = valueColor ?: colors.ink)
    }
}
