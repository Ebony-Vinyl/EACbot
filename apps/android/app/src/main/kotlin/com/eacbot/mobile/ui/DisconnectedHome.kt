package com.eacbot.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.eacbot.mobile.design.LocalEacbotColors

/**
 * What a section shows before this phone is paired. With a [draft] it keeps the
 * chat layout so the person can start typing; otherwise it invites pairing.
 */
@Composable
fun DisconnectedHome(
    title: String,
    defaultLabel: String,
    notice: String?,
    onPair: suspend (String, String, String) -> Result<Unit>,
    draft: String? = null,
    onDraft: (String) -> Unit = {},
) {
    val colors = LocalEacbotColors.current
    var pairing by rememberSaveable { mutableStateOf(false) }
    BackHandler(pairing) { pairing = false }

    if (pairing) {
        PairingScreen(
            defaultLabel = defaultLabel,
            notice = notice,
            onPair = onPair,
            onBack = { pairing = false },
        )
        return
    }

    Column(Modifier.fillMaxSize().background(colors.canvas).imePadding()) {
        AgentHeader(
            name = "EACbot",
            status = "未连接电脑",
            statusColor = colors.inkMuted,
            leading = { MenuButton() },
            trailing = { CircleButton(Icons.Filled.Link, "连接电脑", { pairing = true }) },
        )
        if (draft != null) {
            Box(Modifier.weight(1f)) {
                EmptyHero(
                    title = "嗨，我是 EACbot",
                    detail = "连接你的电脑后，我就能帮你处理电脑上的工作。",
                    modifier = Modifier.align(androidx.compose.ui.Alignment.Center),
                )
            }
            NoticeBanner(
                text = notice ?: "尚未连接电脑",
                tone = if (notice != null) StatusTone.Failed else StatusTone.Quiet,
                action = "去连接",
                onAction = { pairing = true },
            )
            MessageComposer(draft, onDraft, { pairing = true }, Modifier.navigationBarsPadding())
        } else {
            Spacer(Modifier.weight(1f))
            EmptyHero(
                title = "还没有连接$title",
                detail = notice ?: "配对后，可以在手机上创建任务、查看进度和审批。",
                action = "连接电脑",
                onAction = { pairing = true },
            )
            Spacer(Modifier.weight(1.3f))
        }
    }
}
