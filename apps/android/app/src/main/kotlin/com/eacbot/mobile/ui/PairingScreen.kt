package com.eacbot.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.core.ApiException
import com.eacbot.mobile.core.NetworkException
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Pairing: the address of the core plus the one-time code the core printed in
 * the local terminal.
 *
 * The code is short-lived and single use, so the screen says when one has
 * expired instead of retrying it silently. Nothing here stores anything: the
 * connection layer writes the bearer into encrypted storage only after the core
 * has answered with a session.
 */
@Composable
fun PairingScreen(
    defaultLabel: String,
    onPair: suspend (baseUrl: String, code: String, label: String) -> Result<Unit>,
    notice: String? = null,
    heading: String = "你的本地服务",
    description: String = "服务运行在你自己的电脑上。启动后，输入终端显示的地址和配对码。",
) {
    val colors = LocalEacbotColors.current
    var address by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var label by remember { mutableStateOf(defaultLabel) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    fun submit() {
        if (busy) return
        val cleanCode = code.trim()
        if (address.isBlank()) {
            error = "输入服务显示的地址"
            return
        }
        if (cleanCode.length < 4) {
            error = "输入配对码"
            return
        }
        focus.clearFocus()
        busy = true
        error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) { onPair(address, cleanCode, label.ifBlank { defaultLabel }) }
            busy = false
            result.onFailure { failure ->
                error = when (failure) {
                    is ApiException -> when (failure.details.code) {
                        "pairing_expired" -> "配对码已过期，请在电脑上生成新的配对码。"
                        "pairing_unknown" -> "配对码不匹配，请查看终端中的当前配对码。"
                        "pairing_exhausted" -> "错误次数过多，请在电脑上生成新的配对码。"
                        "forbidden" -> "电脑拒绝配对，请查看其终端。"
                        else -> failure.details.message
                    }
                    is NetworkException -> "无法连接此地址，请确认电脑已开机且地址正确。"
                    else -> failure.message ?: "配对失败"
                }
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas)
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = EacbotDimens.gutterWide, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text(
            text = heading,
            style = MaterialTheme.typography.displaySmall,
            color = colors.ink,
        )
        Text(
            text = description,
            style = MaterialTheme.typography.bodyLarge,
            color = colors.inkMuted,
        )

        if (notice != null) {
            Text(
                text = notice,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.attention,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.surfaceRaised, RoundedCornerShape(EacbotDimens.controlRadius))
                    .padding(12.dp),
            )
        }

        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = address,
            onValueChange = { address = it.trim() },
            label = { Text("服务地址") },
            placeholder = { Text("192.168.1.20:8789") },
            singleLine = true,
            enabled = !busy,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Next,
            ),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(EacbotDimens.controlRadius),
        )
        OutlinedTextField(
            value = code,
            onValueChange = { code = it.trim() },
            label = { Text("配对码") },
            placeholder = { Text("ABCD-EFGH") },
            singleLine = true,
            enabled = !busy,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Next,
            ),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(EacbotDimens.controlRadius),
        )
        OutlinedTextField(
            value = label,
            onValueChange = { label = it },
            label = { Text("此手机的名称") },
            singleLine = true,
            enabled = !busy,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(EacbotDimens.controlRadius),
        )

        if (error != null) {
            Text(error!!, style = MaterialTheme.typography.bodyMedium, color = colors.danger)
        }

        Button(
            onClick = { submit() },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(EacbotDimens.controlRadius),
            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
        ) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = colors.accentInk,
                )
                Spacer(Modifier.size(10.dp))
                Text("正在配对")
            } else {
                Text("配对此手机", style = MaterialTheme.typography.labelLarge)
            }
        }

        Text(
            text = "配对码仅使用一次，约十分钟后过期。此手机将获得独立会话，可随时撤销。",
            style = MaterialTheme.typography.bodySmall,
            color = colors.inkMuted,
            textAlign = TextAlign.Start,
        )
    }
}

/** Shown when the core refused the bearer and the credential was cleared. */
@Composable
fun SignedOutScreen(reason: String, onPairAgain: () -> Unit) {
    val colors = LocalEacbotColors.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas)
            .safeDrawingPadding()
            .padding(EacbotDimens.gutterWide),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.Start,
    ) {
        Text("已退出登录", style = MaterialTheme.typography.headlineSmall, color = colors.ink)
        Spacer(Modifier.height(8.dp))
        Text(reason, style = MaterialTheme.typography.bodyLarge, color = colors.inkMuted)
        Spacer(Modifier.height(8.dp))
        Text(
            "请重新配对以继续使用此手机，电脑上的内容未更改。",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.inkMuted,
        )
        Spacer(Modifier.height(20.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onPairAgain,
                shape = RoundedCornerShape(EacbotDimens.controlRadius),
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentInk),
            ) { Text("重新配对") }
            TextButton(onClick = onPairAgain) { Text("输入其他地址") }
        }
    }
}
