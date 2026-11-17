package com.eacbot.mobile.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardReturn
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.eacbot.mobile.core.Cell
import com.eacbot.mobile.core.CellStyle
import com.eacbot.mobile.core.TerminalColor
import com.eacbot.mobile.core.TerminalConnectionState
import com.eacbot.mobile.core.TerminalRole
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors

/**
 * A terminal on a phone.
 *
 * The screen is drawn from the parsed grid, not from raw escape bytes, so a
 * colour or a cursor position is the program's own and not this app's guess.
 * An observer can read it; only a controller can type, and the toggle says
 * which one this viewer is holding.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    title: String,
    viewModel: TerminalViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val colors = LocalEacbotColors.current
    var keyboardOpen by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    var measured by remember { mutableStateOf(80 to 24) }
    val density = LocalDensity.current

    LaunchedEffect(Unit) { viewModel.start() }

    Scaffold(
        containerColor = colors.code,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = state.title.ifBlank { title },
                            style = MaterialTheme.typography.titleSmall,
                            color = colors.ink,
                            maxLines = 1,
                        )
                        Text(
                            text = statusLine(state),
                            style = MaterialTheme.typography.labelSmall,
                            color = when {
                                state.isReconnecting -> colors.attention
                                state.error != null -> colors.danger
                                else -> colors.inkMuted
                            },
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = colors.ink)
                    }
                },
                actions = {
                    if (state.isReconnecting || state.connection is TerminalConnectionState.Failed) {
                        IconButton(onClick = viewModel::retry) {
                            Icon(Icons.Filled.Refresh, contentDescription = "Reconnect now", tint = colors.ink)
                        }
                    }
                    IconButton(onClick = { keyboardOpen = !keyboardOpen }) {
                        Icon(Icons.Filled.Keyboard, contentDescription = "Keyboard", tint = colors.ink)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surface, titleContentColor = colors.ink),
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().background(colors.surface).imePadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = state.role == TerminalRole.Observe,
                        onClick = { viewModel.setRole(TerminalRole.Observe) },
                        label = { Text("Watch") },
                        leadingIcon = { Icon(Icons.Filled.Visibility, contentDescription = null, modifier = Modifier.size(16.dp)) },
                    )
                    FilterChip(
                        selected = state.role == TerminalRole.Control,
                        onClick = { viewModel.setRole(TerminalRole.Control) },
                        label = { Text("Control") },
                        leadingIcon = { Icon(Icons.Filled.Keyboard, contentDescription = null, modifier = Modifier.size(16.dp)) },
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        text = "${state.cols}×${state.rows}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.inkMuted,
                    )
                }
                if (!state.canType) {
                    Text(
                        text = when {
                            state.role == TerminalRole.Observe -> "Watching only. Switch to Control to type."
                            state.isLive -> "This viewer was not granted control."
                            else -> "Connecting…"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.inkMuted,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                    )
                }
                if (keyboardOpen && state.canType) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            value = typed,
                            onValueChange = {
                                // Each keystroke goes out as it is typed, the way
                                // a shell expects; the field stays a send box for
                                // multi-character paste.
                                typed = it
                            },
                            placeholder = { Text("Type here") },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                            shape = RoundedCornerShape(EacbotDimens.controlRadius),
                        )
                        IconButton(
                            onClick = {
                                viewModel.sendInput((typed + "\n").toByteArray())
                                typed = ""
                            },
                        ) { Icon(Icons.AutoMirrored.Filled.KeyboardReturn, contentDescription = "Send") }
                        IconButton(onClick = { viewModel.sendInput(byteArrayOf(0x03)) }) {
                            Icon(Icons.Filled.Close, contentDescription = "Send Ctrl-C")
                        }
                    }
                    QuickKeys(onSend = viewModel::sendInput)
                }
                Spacer(Modifier.height(2.dp))
            }
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .background(colors.code)
                .safeDrawingPadding(),
        ) {
            if (state.loading) {
                Text("Opening terminal…", style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted, modifier = Modifier.padding(16.dp))
            }
            TerminalCanvas(
                lines = state.lines,
                cols = state.cols,
                rows = state.rows,
                isDark = colors.isDark,
                onSize = { c, r -> measured = c to r; viewModel.resize(c, r) },
                modifier = Modifier.fillMaxSize(),
            )
            if (state.isReconnecting) {
                Row(
                    Modifier
                        .align(Alignment.TopCenter)
                        .padding(8.dp)
                        .background(colors.surfaceRaised, RoundedCornerShape(percent = 50))
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Reconnecting", style = MaterialTheme.typography.labelSmall, color = colors.attention)
                    TextButton(onClick = viewModel::retry) { Text("Retry", style = MaterialTheme.typography.labelSmall) }
                }
            }
            if (state.error != null && !state.isReconnecting) {
                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .padding(12.dp)
                        .background(colors.surface, RoundedCornerShape(EacbotDimens.controlRadius))
                        .padding(12.dp),
                ) {
                    Text(state.error!!, style = MaterialTheme.typography.bodySmall, color = colors.danger)
                    TextButton(onClick = viewModel::retry) { Text("Try again") }
                }
            }
        }
    }
}

@Composable
private fun QuickKeys(onSend: (ByteArray) -> Unit) {
    val keys = listOf(
        "Tab" to byteArrayOf(0x09),
        "Esc" to byteArrayOf(0x1b),
        "↑" to byteArrayOf(0x1b, 0x5b, 0x41),
        "↓" to byteArrayOf(0x1b, 0x5b, 0x42),
        "←" to byteArrayOf(0x1b, 0x5b, 0x44),
        "→" to byteArrayOf(0x1b, 0x5b, 0x43),
        "Ctrl-C" to byteArrayOf(0x03),
        "Ctrl-D" to byteArrayOf(0x04),
        "Ctrl-Z" to byteArrayOf(0x1a),
    )
    val colors = LocalEacbotColors.current
    LazyRow(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(keys, key = { it.first }) { (label, bytes) ->
            Box(
                Modifier
                    .background(colors.surfaceRaised, RoundedCornerShape(8.dp))
                    .pointerInput(label) { detectTapGestures { onSend(bytes) } }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = colors.ink)
            }
        }
    }
}

/**
 * Draws the grid.
 *
 * A cell is measured once and every line is drawn at a fixed advance, so a
 * column lines up under the one above it. The size reported back is the grid
 * the container can actually hold, which is how the phone tells the core how
 * many columns it wants.
 */
@Composable
private fun TerminalCanvas(
    lines: List<List<Cell>>,
    cols: Int,
    rows: Int,
    isDark: Boolean,
    onSize: (Int, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val textMeasurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val fontSize = 12.sp
    val style = TextStyle(fontSize = fontSize, fontFamily = FontFamily.Monospace)
    val metrics = remember(textMeasurer, fontSize) {
        val result = textMeasurer.measure("M", style)
        result.size.width.toFloat() to result.size.height.toFloat()
    }

    Box(
        modifier.pointerInput(cols, rows, lines.size) {
            val charWidth = metrics.first.coerceAtLeast(1f)
            val charHeight = metrics.second.coerceAtLeast(1f)
            val nextCols = (size.width / charWidth).toInt().coerceIn(20, 400)
            val nextRows = (size.height / charHeight).toInt().coerceIn(6, 200)
            if (nextCols != cols || nextRows != rows) onSize(nextCols, nextRows)
        },
    ) {
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
            drawGrid(lines, textMeasurer, style, metrics.first, metrics.second, isDark)
        }
    }
}

private fun DrawScope.drawGrid(
    lines: List<List<Cell>>,
    measurer: TextMeasurer,
    style: TextStyle,
    charWidth: Float,
    charHeight: Float,
    isDark: Boolean,
) {
    val defaultForeground = if (isDark) Color(0xFFEDEFF2) else Color(0xFF171A1E)
    val defaultBackground = if (isDark) Color(0xFF10151B) else Color(0xFFF2EFE9)
    var y = 0f
    for (row in lines) {
        var x = 0f
        for (cell in row) {
            val styleForCell = cell.style
            val background = colourOf(styleForCell.background, isDark, foreground = false) ?: defaultBackground
            val foreground = colourOf(styleForCell.foreground, isDark, foreground = true) ?: defaultForeground
            val painted = if (styleForCell.inverse) {
                Pair(background, foreground)
            } else {
                Pair(foreground, background)
            }
            if (painted.second != defaultBackground) {
                drawRect(color = painted.second, topLeft = Offset(x, y), size = androidx.compose.ui.geometry.Size(charWidth, charHeight))
            }
            if (cell.char.isNotEmpty() && cell.char != " ") {
                val textStyle = style.copy(
                    color = painted.first,
                    fontWeight = if (styleForCell.bold) androidx.compose.ui.text.font.FontWeight.Bold else null,
                    textDecoration = if (styleForCell.underline) {
                        androidx.compose.ui.text.style.TextDecoration.Underline
                    } else {
                        null
                    },
                )
                val layout = measurer.measure(cell.char, textStyle)
                drawText(layout, topLeft = Offset(x, y))
            }
            x += charWidth
        }
        y += charHeight
    }
}

/** The 16-colour ANSI palette, in both themes. A colour the program asked for
 * by index resolves here; a true-colour value is used as sent. */
private fun colourOf(colour: TerminalColor, isDark: Boolean, foreground: Boolean): Color? {
    if (colour.isDefault) return null
    if (colour.isRgb) {
        val rgb = colour.rgbValue
        return Color(0xFF000000 or rgb.toLong())
    }
    val palette = if (isDark) DARK_PALETTE else LIGHT_PALETTE
    return palette.getOrNull(colour.value) ?: null
}

private val DARK_PALETTE = listOf(
    Color(0xFF1B2026), Color(0xFFE98A82), Color(0xFF8FD6A4), Color(0xFFE9B472),
    Color(0xFF7FB2E5), Color(0xFFC79BE8), Color(0xFF7FD1C1), Color(0xFFCBD3DC),
    Color(0xFF5A6674), Color(0xFFFF9E96), Color(0xFFA6E8B8), Color(0xFFF5C98A),
    Color(0xFF9CC9F5), Color(0xFFDBB4F2), Color(0xFF9FE6D8), Color(0xFFEDEFF2),
)

private val LIGHT_PALETTE = listOf(
    Color(0xFF2A3038), Color(0xFFA53A31), Color(0xFF2C6B43), Color(0xFF9A5B10),
    Color(0xFF245C8C), Color(0xFF6B3E8C), Color(0xFF1F6F63), Color(0xFF5F6A76),
    Color(0xFF7B8592), Color(0xFFC2554B), Color(0xFF3E7F55), Color(0xFFB37A2A),
    Color(0xFF3A76AC), Color(0xFF8557A8), Color(0xFF2F8478), Color(0xFF171A1E),
)

private fun statusLine(state: TerminalUiState): String = when (val connection = state.connection) {
    is TerminalConnectionState.Live -> when {
        state.exitCode != null -> "Exited (${state.exitCode})"
        state.status != null -> state.status!!
        state.canType -> "Live · you have control"
        else -> "Live · watching"
    }
    is TerminalConnectionState.Connecting -> "Connecting"
    is TerminalConnectionState.Reconnecting -> "Reconnecting (attempt ${connection.attempt})"
    is TerminalConnectionState.Exited -> "Exited: ${connection.reason}"
    is TerminalConnectionState.Failed -> connection.message
    TerminalConnectionState.Idle -> "Starting"
    TerminalConnectionState.Closed -> "Closed"
}
