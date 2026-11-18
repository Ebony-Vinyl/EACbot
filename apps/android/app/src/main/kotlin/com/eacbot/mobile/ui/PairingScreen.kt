package com.eacbot.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.KeyboardType
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
    heading: String = "连接你的电脑",
    description: String = "在电脑上启动 EACbot，输入它显示的服务地址和配对码。",
    onBack: (() -> Unit)? = null,
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
            .background(colors.canvasGrouped)
            .imePadding(),
    ) {
        PageHeader(title = "连接电脑", onBack = onBack)
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding(),
        ) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                CompanionAvatar(72.dp)
                Gap(6.dp)
                Text(heading, style = MaterialTheme.typography.headlineSmall, color = colors.ink, textAlign = TextAlign.Center)
                Text(description, style = MaterialTheme.typography.bodyMedium, color = colors.inkMuted, textAlign = TextAlign.Center)
            }

            if (notice != null) {
                Gap(4.dp)
                NoticeBanner(notice, tone = StatusTone.Waiting)
            }

            GroupLabel("电脑上显示的信息")
            GroupCard {
                GroupTextField(
                    label = "服务地址",
                    value = address,
                    onValueChange = { address = it.trim() },
                    placeholder = "192.168.1.20:8789",
                    enabled = !busy,
                    divider = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                    ),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                )
                GroupTextField(
                    label = "配对码",
                    value = code,
                    onValueChange = { code = it.trim() },
                    placeholder = "ABCD-EFGH",
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Characters,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                )
            }

            GroupLabel("此手机")
            GroupCard {
                GroupTextField(
                    label = "设备名称",
                    value = label,
                    onValueChange = { label = it },
                    placeholder = defaultLabel,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                )
            }

            if (error != null) {
                Gap(14.dp)
                NoticeBanner(error!!, tone = StatusTone.Failed)
            }

            Gap(24.dp)
            PrimaryButton(
                text = "配对此手机",
                onClick = { submit() },
                busy = busy,
                busyText = "正在配对",
                modifier = Modifier.fillMaxWidth().padding(horizontal = EacbotDimens.gutter),
            )
            Text(
                text = "配对码仅使用一次，约十分钟后过期。此手机将获得独立会话，可随时撤销。",
                style = MaterialTheme.typography.bodySmall,
                color = colors.inkMuted,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 14.dp),
            )
            Gap(24.dp)
        }
    }
}

/** Shown when the core refused the bearer and the credential was cleared. */
@Composable
fun SignedOutScreen(reason: String, onPairAgain: () -> Unit) {
    val colors = LocalEacbotColors.current
    Column(
        modifier = Modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding(),
        verticalArrangement = Arrangement.Center,
    ) {
        EmptyHero(
            title = "已退出登录",
            detail = "$reason\n请重新配对以继续使用此手机，电脑上的内容未更改。",
            action = "重新配对",
            onAction = onPairAgain,
        )
    }
}
