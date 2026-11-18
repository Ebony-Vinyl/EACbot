package com.eacbot.mobile.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.R
import com.eacbot.mobile.core.MissionStatus
import com.eacbot.mobile.design.EacbotColors
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.design.LocalReducedMotion

@Composable
fun Modifier.floating(shape: Shape, elevation: Dp = 10.dp): Modifier {
    val shadow = LocalEacbotColors.current.shadow
    return this.shadow(elevation, shape, clip = false, ambientColor = shadow, spotColor = shadow)
}

@Composable
fun CircleButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color? = null,
) {
    val colors = LocalEacbotColors.current
    Box(
        modifier
            .size(EacbotDimens.floatingButton)
            .floating(CircleShape)
            .clip(CircleShape)
            .background(colors.surface)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(22.dp).alpha(if (enabled) 1f else 0.4f), tint = tint ?: colors.ink)
    }
}

@Composable
fun CompanionAvatar(size: Dp, modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(R.drawable.companion_portrait),
        contentDescription = null,
        modifier = modifier.size(size).clip(CircleShape),
    )
}

/** The avatar with its name pill, flanked by floating round buttons. */
@Composable
fun AgentHeader(
    name: String,
    modifier: Modifier = Modifier,
    status: String? = null,
    statusColor: Color? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = LocalEacbotColors.current
    Box(
        modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 6.dp),
    ) {
        Box(Modifier.align(Alignment.TopStart).padding(top = 6.dp)) { leading?.invoke() }
        Box(Modifier.align(Alignment.TopCenter), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier
                    .padding(top = 46.dp)
                    .floating(RoundedCornerShape(18.dp), 8.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(colors.surface)
                    .widthIn(min = 72.dp, max = 240.dp)
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() },
                )
                if (status != null) {
                    Text(
                        status,
                        style = MaterialTheme.typography.bodySmall,
                        color = statusColor ?: colors.inkMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            CompanionAvatar(56.dp)
        }
        Box(Modifier.align(Alignment.TopEnd).padding(top = 6.dp)) { trailing?.invoke() }
    }
}

/** A sub-page header: a round back button and a centred title. */
@Composable
fun PageHeader(
    title: String,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    subtitleColor: Color? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val colors = LocalEacbotColors.current
    Box(
        modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .heightIn(min = EacbotDimens.floatingButton),
    ) {
        if (onBack != null) {
            CircleButton(
                Icons.AutoMirrored.Filled.ArrowBack,
                "返回",
                onBack,
                Modifier.align(Alignment.CenterStart),
            )
        }
        Column(
            Modifier.align(Alignment.Center).padding(horizontal = 60.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { heading() },
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = subtitleColor ?: colors.inkMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            Modifier.align(Alignment.CenterEnd),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = actions,
        )
    }
}

@Composable
fun LargeTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.headlineMedium,
        color = LocalEacbotColors.current.ink,
        modifier = modifier
            .padding(horizontal = EacbotDimens.gutterWide, vertical = 8.dp)
            .semantics { heading() },
    )
}

@Composable
fun GroupLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = LocalEacbotColors.current.inkMuted,
        modifier = modifier.padding(start = 28.dp, end = 28.dp, top = 20.dp, bottom = 8.dp),
    )
}

@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val colors = LocalEacbotColors.current
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = EacbotDimens.gutter)
            .clip(RoundedCornerShape(EacbotDimens.groupRadius))
            .background(colors.surface),
        content = content,
    )
}

@Composable
fun GroupRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    titleColor: Color? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = { Chevron() },
    divider: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val colors = LocalEacbotColors.current
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
                .heightIn(min = 60.dp)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = titleColor ?: colors.ink,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!subtitle.isNullOrBlank()) {
                    Text(
                        subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.inkMuted,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            trailing?.invoke()
        }
        if (divider) Hairline(Modifier.padding(start = if (leading != null) 66.dp else 16.dp, end = 16.dp))
    }
}

@Composable
fun ValueRow(label: String, value: String, divider: Boolean = false, valueColor: Color? = null) {
    val colors = LocalEacbotColors.current
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted)
            Text(
                value,
                style = MaterialTheme.typography.bodyMedium,
                color = valueColor ?: colors.ink,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        }
        if (divider) Hairline(Modifier.padding(horizontal = 16.dp))
    }
}

@Composable
fun Chevron() {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        null,
        tint = LocalEacbotColors.current.inkFaint,
        modifier = Modifier.size(22.dp),
    )
}

@Composable
fun IconTile(icon: ImageVector, tint: Color, background: Color, modifier: Modifier = Modifier, size: Dp = 36.dp) {
    Box(
        modifier.size(size).clip(RoundedCornerShape(size * 0.3f)).background(background),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(size * 0.56f))
    }
}

@Composable
fun InitialTile(name: String, modifier: Modifier = Modifier, size: Dp = 40.dp) {
    val colors = LocalEacbotColors.current
    Box(
        modifier.size(size).clip(CircleShape).background(colors.accentSoft),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.trim().take(1).ifEmpty { "?" },
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = colors.accent,
        )
    }
}

@Composable
fun ActionText(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color? = null, enabled: Boolean = true) {
    val colors = LocalEacbotColors.current
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        color = (color ?: colors.accent).copy(alpha = if (enabled) 1f else 0.4f),
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 6.dp),
    )
}

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    busyText: String = text,
) {
    val colors = LocalEacbotColors.current
    val active = enabled && !busy
    Box(
        modifier
            .heightIn(min = 50.dp)
            .clip(CircleShape)
            .then(
                if (enabled || busy) Modifier.background(colors.primaryBrush)
                else Modifier.background(colors.outline),
            )
            .clickable(enabled = active, role = Role.Button, onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accentInk)
            Text(
                if (busy) busyText else text,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = if (enabled || busy) colors.accentInk else colors.inkFaint,
            )
        }
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentColor: Color? = null,
) {
    val colors = LocalEacbotColors.current
    Box(
        modifier
            .heightIn(min = 50.dp)
            .clip(CircleShape)
            .background(colors.surfaceRaised)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = (contentColor ?: colors.ink).copy(alpha = if (enabled) 1f else 0.4f),
        )
    }
}

@Composable
fun SearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = EacbotDimens.gutter)
            .clip(CircleShape)
            .background(colors.surface)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Filled.Search, null, tint = colors.inkMuted, modifier = Modifier.size(22.dp))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.ink),
            cursorBrush = SolidColor(colors.accent),
            modifier = Modifier.weight(1f),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = colors.inkFaint)
                    inner()
                }
            },
        )
    }
}

/** A labelled text input that sits inside a [GroupCard]. */
@Composable
fun GroupTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    singleLine: Boolean = true,
    minLines: Int = 1,
    enabled: Boolean = true,
    divider: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val colors = LocalEacbotColors.current
    Column(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = colors.inkMuted)
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = singleLine,
                minLines = minLines,
                maxLines = if (singleLine) 1 else 12,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.ink),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = keyboardOptions,
                keyboardActions = keyboardActions,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
                decorationBox = { inner ->
                    Box {
                        if (value.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = colors.inkFaint)
                        inner()
                    }
                },
            )
        }
        if (divider) Hairline(Modifier.padding(horizontal = 16.dp))
    }
}

/** A status group heading: a dot in a soft ring and the group's name. */
@Composable
fun StatusHeading(text: String, tone: StatusTone, modifier: Modifier = Modifier, count: Int? = null) {
    val colors = LocalEacbotColors.current
    val (ink, soft) = tone.colors(colors)
    Row(
        modifier.padding(horizontal = EacbotDimens.gutterWide, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(soft), contentAlignment = Alignment.Center) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(ink))
        }
        Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = ink)
        if (count != null) Text("$count", style = MaterialTheme.typography.labelMedium, color = colors.inkFaint)
    }
}

enum class StatusTone {
    Working, Waiting, Done, Failed, Quiet;

    fun colors(colors: EacbotColors): Pair<Color, Color> = when (this) {
        Working -> colors.accent to colors.accentSoft
        Waiting -> colors.attention to colors.attentionSoft
        Done -> colors.success to colors.successSoft
        Failed -> colors.danger to colors.dangerSoft
        Quiet -> colors.inkMuted to colors.surfaceRaised
    }
}

fun statusTone(status: MissionStatus): StatusTone = when (status) {
    MissionStatus.Running, MissionStatus.Resuming, MissionStatus.Provisioning, MissionStatus.Queued -> StatusTone.Working
    MissionStatus.WaitingInput, MissionStatus.WaitingChildren, MissionStatus.Interrupted -> StatusTone.Waiting
    MissionStatus.Succeeded -> StatusTone.Done
    MissionStatus.Failed -> StatusTone.Failed
    MissionStatus.Cancelled -> StatusTone.Quiet
}

/** A status is always a dot *and* a word, so colour is never the only signal. */
@Composable
fun StatusPill(status: MissionStatus, modifier: Modifier = Modifier, compact: Boolean = false) {
    val colors = LocalEacbotColors.current
    val (ink, soft) = statusTone(status).colors(colors)
    Row(
        modifier
            .clip(CircleShape)
            .background(soft)
            .padding(horizontal = if (compact) 8.dp else 10.dp, vertical = 3.dp)
            .semantics { contentDescription = "状态：${statusLabel(status)}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(ink))
        Text(statusLabel(status), style = MaterialTheme.typography.labelSmall, color = ink)
    }
}

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

@Composable
fun chatBubbleMaxWidth(): Dp = (LocalConfiguration.current.screenWidthDp * 0.82f).dp

@Composable
fun ChatBubble(text: String, fromUser: Boolean, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Box(modifier.fillMaxWidth(), contentAlignment = if (fromUser) Alignment.CenterEnd else Alignment.CenterStart) {
        SelectionContainer {
            Text(
                text,
                style = MaterialTheme.typography.bodyLarge,
                color = colors.ink,
                modifier = Modifier
                    .widthIn(max = chatBubbleMaxWidth())
                    .clip(RoundedCornerShape(EacbotDimens.bubbleRadius))
                    .background(if (fromUser) colors.bubbleUser else colors.bubbleAgent)
                    .padding(horizontal = 18.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
fun TypingBubble(modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    val reduced = LocalReducedMotion.current
    val transition = rememberInfiniteTransition(label = "typing")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3f,
        animationSpec = infiniteRepeatable(tween(1200), RepeatMode.Restart),
        label = "phase",
    )
    Row(
        modifier
            .clip(RoundedCornerShape(EacbotDimens.bubbleRadius))
            .background(colors.bubbleAgent)
            .padding(horizontal = 18.dp, vertical = 16.dp)
            .semantics { contentDescription = "正在处理" },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        repeat(3) { index ->
            val lifted = !reduced && phase.toInt() == index
            Box(
                Modifier
                    .padding(top = if (lifted) 0.dp else 3.dp, bottom = if (lifted) 3.dp else 0.dp)
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (lifted) colors.inkMuted else colors.inkFaint),
            )
        }
    }
}

@Composable
fun CaptionChip(text: String, modifier: Modifier = Modifier, color: Color? = null) {
    val colors = LocalEacbotColors.current
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = color ?: colors.inkMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .clip(CircleShape)
                .background(colors.surfaceRaised)
                .padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

/** An empty state that says what is missing and what to do next. */
@Composable
fun EmptyHero(
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val colors = LocalEacbotColors.current
    Column(
        modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CompanionAvatar(84.dp)
        Spacer(Modifier.height(4.dp))
        Text(title, style = MaterialTheme.typography.headlineSmall, color = colors.ink, textAlign = TextAlign.Center)
        Text(detail, style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted, textAlign = TextAlign.Center)
        if (action != null && onAction != null) {
            Spacer(Modifier.height(8.dp))
            PrimaryButton(action, onAction, Modifier.widthIn(min = 180.dp))
        }
    }
}

@Composable
fun EmptyNote(title: String, detail: String, modifier: Modifier = Modifier) {
    val colors = LocalEacbotColors.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(EacbotDimens.groupRadius))
            .background(colors.surface)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = colors.ink)
        Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
    }
}

@Composable
fun NoticeBanner(text: String, modifier: Modifier = Modifier, tone: StatusTone = StatusTone.Waiting, action: String? = null, onAction: (() -> Unit)? = null) {
    val colors = LocalEacbotColors.current
    val (ink, soft) = tone.colors(colors)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = EacbotDimens.gutter)
            .clip(RoundedCornerShape(16.dp))
            .background(soft)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = ink, modifier = Modifier.weight(1f))
        if (action != null && onAction != null) ActionText(action, onAction, color = ink)
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(EacbotDimens.hairline).background(LocalEacbotColors.current.outline))
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) = GroupLabel(text, modifier)

@Composable
fun MetaPair(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color? = null) {
    val colors = LocalEacbotColors.current
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
        Text(value, style = MaterialTheme.typography.labelSmall, color = valueColor ?: colors.ink)
    }
}

@Composable
fun Gap(height: Dp) = Spacer(Modifier.height(height))

@Composable
fun HGap(width: Dp) = Spacer(Modifier.width(width))

@Composable
fun ChoicePill(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val colors = LocalEacbotColors.current
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
        color = if (selected) colors.accentInk else colors.ink.copy(alpha = if (enabled) 1f else 0.4f),
        maxLines = 1,
        modifier = modifier
            .clip(CircleShape)
            .then(if (selected) Modifier.background(colors.ink) else Modifier.background(colors.surface))
            .clickable(enabled = enabled, role = Role.Tab, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 9.dp),
    )
}

@Composable
fun <T> ChoiceRow(
    options: List<T>,
    selected: T?,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    androidx.compose.foundation.lazy.LazyRow(
        modifier = modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = EacbotDimens.gutter),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(options.size) { index ->
            val option = options[index]
            ChoicePill(label(option), option == selected, { onSelect(option) })
        }
    }
}
