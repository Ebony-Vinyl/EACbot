package com.eacbot.mobile.design

import android.provider.Settings
import android.content.Context
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * EACbot's phone palette.
 *
 * It is the app's own skin family rather than a copy of the desktop shell: a
 * near-black ink for dark, warm paper for light, one teal accent and a quiet
 * warm amber for "needs you". Status never depends on colour alone; every dot
 * carries a word beside it.
 */
data class EacbotColors(
    val canvas: Color,
    val surface: Color,
    val surfaceRaised: Color,
    val outline: Color,
    val ink: Color,
    val inkMuted: Color,
    val accent: Color,
    val accentInk: Color,
    val attention: Color,
    val danger: Color,
    val success: Color,
    val code: Color,
    val isDark: Boolean,
)

private val DarkColors = EacbotColors(
    canvas = Color(0xFF0E1116),
    surface = Color(0xFF151A21),
    surfaceRaised = Color(0xFF1D242D),
    outline = Color(0xFF2A333E),
    ink = Color(0xFFEDEFF2),
    inkMuted = Color(0xFF9AA6B4),
    accent = Color(0xFF7FD1C1),
    accentInk = Color(0xFF06211D),
    attention = Color(0xFFE9B472),
    danger = Color(0xFFE98A82),
    success = Color(0xFF8FD6A4),
    code = Color(0xFF10151B),
    isDark = true,
)

private val LightColors = EacbotColors(
    canvas = Color(0xFFF7F5F1),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFF0EDE7),
    outline = Color(0xFFDDD7CC),
    ink = Color(0xFF171A1E),
    inkMuted = Color(0xFF5F6A76),
    accent = Color(0xFF1F6F63),
    accentInk = Color(0xFFF4FFFC),
    attention = Color(0xFF9A5B10),
    danger = Color(0xFFA53A31),
    success = Color(0xFF2C6B43),
    code = Color(0xFFF2EFE9),
    isDark = false,
)

val LocalEacbotColors = staticCompositionLocalOf { DarkColors }

/** Whether the person asked the system to reduce motion. Every transition in
 * this app checks it, and the reduced branch is a cut, not a slower animation. */
val LocalReducedMotion = staticCompositionLocalOf { false }

@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    val value = remember(context) {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }
    return value
}

@Composable
fun EacbotTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    reducedMotion: Boolean = rememberReducedMotion(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val scheme = if (darkTheme) {
        darkColorScheme(
            primary = colors.accent,
            onPrimary = colors.accentInk,
            background = colors.canvas,
            onBackground = colors.ink,
            surface = colors.surface,
            onSurface = colors.ink,
            surfaceVariant = colors.surfaceRaised,
            onSurfaceVariant = colors.inkMuted,
            outline = colors.outline,
            error = colors.danger,
        )
    } else {
        lightColorScheme(
            primary = colors.accent,
            onPrimary = colors.accentInk,
            background = colors.canvas,
            onBackground = colors.ink,
            surface = colors.surface,
            onSurface = colors.ink,
            surfaceVariant = colors.surfaceRaised,
            onSurfaceVariant = colors.inkMuted,
            outline = colors.outline,
            error = colors.danger,
        )
    }

    CompositionLocalProvider(
        LocalEacbotColors provides colors,
        LocalReducedMotion provides reducedMotion,
    ) {
        MaterialTheme(colorScheme = scheme, typography = EacbotTypography, content = content)
    }
}

/** A phone-reading type scale: one step larger than Material's default body,
 * because most of what this app shows is prose an agent wrote. */
val EacbotTypography = Typography(
    displaySmall = TextStyle(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 19.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium),
)

object EacbotDimens {
    val gutter = 16.dp
    val gutterWide = 20.dp
    val cardRadius = 16.dp
    val controlRadius = 12.dp
    val hairline = 1.dp
}
