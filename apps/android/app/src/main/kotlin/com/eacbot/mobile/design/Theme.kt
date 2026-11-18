package com.eacbot.mobile.design

import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class EacbotColors(
    val canvas: Color,
    val canvasGrouped: Color,
    val surface: Color,
    val surfaceRaised: Color,
    val outline: Color,
    val ink: Color,
    val inkMuted: Color,
    val inkFaint: Color,
    val accent: Color,
    val accentEnd: Color,
    val accentInk: Color,
    val accentSoft: Color,
    val bubbleAgent: Color,
    val bubbleUser: Color,
    val shadow: Color,
    val attention: Color,
    val attentionSoft: Color,
    val danger: Color,
    val dangerSoft: Color,
    val success: Color,
    val successSoft: Color,
    val code: Color,
    val isDark: Boolean,
) {
    val primaryBrush: Brush get() = Brush.horizontalGradient(listOf(accent, accentEnd))
}

private val LightColors = EacbotColors(
    canvas = Color(0xFFFAFAFA),
    canvasGrouped = Color(0xFFF2F2F5),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFF1F1F3),
    outline = Color(0xFFE7E7EB),
    ink = Color(0xFF111418),
    inkMuted = Color(0xFF6B7079),
    inkFaint = Color(0xFF9DA2AA),
    accent = Color(0xFF0B5FDB),
    accentEnd = Color(0xFF5155E6),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0xFFDDEBFD),
    bubbleAgent = Color(0xFFECECEF),
    bubbleUser = Color(0xFFCFE4FC),
    shadow = Color(0x1F1B2330),
    attention = Color(0xFFD9800B),
    attentionSoft = Color(0xFFFCEBD3),
    danger = Color(0xFFD23B30),
    dangerSoft = Color(0xFFFBE0DD),
    success = Color(0xFF16A34A),
    successSoft = Color(0xFFD6F3DF),
    code = Color(0xFFF4F2EE),
    isDark = false,
)

private val DarkColors = EacbotColors(
    canvas = Color(0xFF0F1114),
    canvasGrouped = Color(0xFF0B0C0E),
    surface = Color(0xFF1A1D21),
    surfaceRaised = Color(0xFF23272C),
    outline = Color(0xFF2C3036),
    ink = Color(0xFFEDEFF2),
    inkMuted = Color(0xFF9AA2AD),
    inkFaint = Color(0xFF6C737D),
    accent = Color(0xFF3B82F6),
    accentEnd = Color(0xFF6366F1),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0xFF1C2D4A),
    bubbleAgent = Color(0xFF23272C),
    bubbleUser = Color(0xFF1F3A5F),
    shadow = Color(0x66000000),
    attention = Color(0xFFF0B060),
    attentionSoft = Color(0xFF3A2C17),
    danger = Color(0xFFF08A80),
    dangerSoft = Color(0xFF3B1D1A),
    success = Color(0xFF6FD08F),
    successSoft = Color(0xFF16301F),
    code = Color(0xFF10151B),
    isDark = true,
)

val LocalEacbotColors = staticCompositionLocalOf { LightColors }

/** Whether the person asked the system to reduce motion. Every transition in
 * this app checks it, and the reduced branch is a cut, not a slower animation. */
val LocalReducedMotion = staticCompositionLocalOf { false }

@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }
}

@Composable
fun EacbotTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    reducedMotion: Boolean = rememberReducedMotion(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val base = if (darkTheme) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = colors.accent,
        onPrimary = colors.accentInk,
        primaryContainer = colors.accentSoft,
        onPrimaryContainer = colors.ink,
        secondary = colors.inkMuted,
        secondaryContainer = colors.surfaceRaised,
        onSecondaryContainer = colors.ink,
        background = colors.canvas,
        onBackground = colors.ink,
        surface = colors.surface,
        onSurface = colors.ink,
        surfaceVariant = colors.surfaceRaised,
        onSurfaceVariant = colors.inkMuted,
        surfaceContainerLowest = colors.surface,
        surfaceContainerLow = colors.surface,
        surfaceContainer = colors.surface,
        surfaceContainerHigh = colors.surface,
        surfaceContainerHighest = colors.surfaceRaised,
        surfaceTint = Color.Transparent,
        outline = colors.inkFaint,
        outlineVariant = colors.outline,
        error = colors.danger,
    )

    CompositionLocalProvider(
        LocalEacbotColors provides colors,
        LocalReducedMotion provides reducedMotion,
    ) {
        MaterialTheme(colorScheme = scheme, typography = EacbotTypography, content = content)
    }
}

val EacbotTypography = Typography(
    displaySmall = TextStyle(fontSize = 30.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold),
    headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 19.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 17.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 15.sp, fontWeight = FontWeight.Medium),
)

object EacbotDimens {
    val gutter = 16.dp
    val gutterWide = 20.dp
    val bubbleRadius = 22.dp
    val cardRadius = 24.dp
    val groupRadius = 20.dp
    val controlRadius = 18.dp
    val hairline = 0.5.dp
    val floatingButton = 44.dp
}
