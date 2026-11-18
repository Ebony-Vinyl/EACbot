package com.eacbot.mobile.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.MicNone
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.design.LocalEacbotColors

/** The floating pill composer: tools, text, then voice or send. */
@Composable
fun MessageComposer(
    text: String,
    change: (String) -> Unit,
    send: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    hint: String = "发送消息",
) {
    val colors = LocalEacbotColors.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var toolsOpen by remember { mutableStateOf(false) }
    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { change(text + it) }
    }
    val shape = RoundedCornerShape(28.dp)

    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 8.dp)
            .floating(shape, 12.dp)
            .clip(shape)
            .background(colors.surface)
            .heightIn(min = 56.dp)
            .padding(horizontal = 6.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            ComposerIcon(Icons.Filled.Add, "输入工具", enabled) { toolsOpen = true }
            DropdownMenu(expanded = toolsOpen, onDismissRequest = { toolsOpen = false }) {
                DropdownMenuItem(
                    text = { Text("粘贴文本") },
                    leadingIcon = { Icon(Icons.Filled.ContentPaste, null) },
                    onClick = {
                        toolsOpen = false
                        clipboard.getText()?.let { change(text + it.text) }
                    },
                )
            }
        }
        BasicTextField(
            value = text,
            onValueChange = change,
            enabled = enabled,
            maxLines = 6,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.ink),
            cursorBrush = SolidColor(colors.accent),
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 4.dp, vertical = 12.dp)
                .semantics { contentDescription = hint },
            decorationBox = { inner ->
                Box {
                    if (text.isEmpty()) Text(hint, style = MaterialTheme.typography.bodyLarge, color = colors.inkFaint)
                    inner()
                }
            },
        )
        if (text.isBlank()) {
            ComposerIcon(Icons.Filled.MicNone, "语音输入", enabled) {
                try {
                    voice.launch(
                        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM),
                    )
                } catch (_: ActivityNotFoundException) {
                    Toast.makeText(context, "设备未安装语音输入服务", Toast.LENGTH_SHORT).show()
                }
            }
        } else {
            Box(
                Modifier
                    .padding(4.dp)
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(colors.primaryBrush)
                    .alpha(if (enabled) 1f else 0.5f)
                    .clickable(enabled = enabled, role = Role.Button, onClick = send)
                    .semantics { contentDescription = "发送" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = colors.accentInk, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun ComposerIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalEacbotColors.current
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = colors.ink.copy(alpha = if (enabled) 1f else 0.35f), modifier = Modifier.size(24.dp))
    }
}
