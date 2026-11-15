package com.eacbot.mobile.design

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer

/**
 * The motion this app uses, and the reduced-motion branch for each.
 *
 * The timings follow the interaction notes: about 120 ms for feedback, 160–180
 * ms for a card arriving with a 4 px rise and a 0.98 scale, and 500 ms with
 * strong deceleration for a large move. A person who asked for reduced motion
 * gets the end state immediately instead of a faster version of the animation.
 */
object Motion {
    const val FeedbackMs = 120
    const val EnterMs = 170
    const val LargeMs = 500

    const val EnterRiseDp = 4f
    const val EnterScale = 0.98f
}

/** A card arriving: a small rise and a small scale, or nothing at all when
 * reduced motion is on. */
@Composable
fun Modifier.enterAnimation(key: Any? = Unit): Modifier {
    val reduced = LocalReducedMotion.current
    if (reduced) return this
    val progress = remember(key) { Animatable(0f) }
    LaunchedEffect(key) { progress.animateTo(1f, tween(Motion.EnterMs, easing = LinearOutSlowInEasing)) }
    return this
        .alpha(progress.value)
        .graphicsLayer {
            translationY = (1f - progress.value) * Motion.EnterRiseDp * density
            scaleX = Motion.EnterScale + (1f - Motion.EnterScale) * progress.value
            scaleY = scaleX
        }
}

/** A status change: a short spring, or an instant swap when reduced motion is
 * on. No endless breathing. */
@Composable
fun animatedProgress(target: Float): Float {
    val reduced = LocalReducedMotion.current
    if (reduced) return target
    val value by animateFloatAsState(
        targetValue = target,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMediumLow),
        label = "status",
    )
    return value
}
