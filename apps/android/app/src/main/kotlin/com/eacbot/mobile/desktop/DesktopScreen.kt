package com.eacbot.mobile.desktop

import androidx.compose.material3.CenterAlignedTopAppBar
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ZoomIn
import androidx.compose.material.icons.filled.ZoomOut
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.design.EacbotDimens
import com.eacbot.mobile.design.LocalEacbotColors
import com.eacbot.mobile.ui.CircleButton
import com.eacbot.mobile.ui.MessageComposer
import com.eacbot.mobile.ui.NoticeBanner
import com.eacbot.mobile.ui.PageHeader
import com.eacbot.mobile.ui.StatusTone
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem

/**
 * The user's own computer, through the noVNC entry the core serves.
 *
 * The WebView is scoped to this one screen and to one same-origin URL the core
 * issued. It is not a shell for the app: no remote script is injected, no
 * bridge exposes the app's own API, and file access is off. When the connection
 * drops the last frame stays on screen with a Reconnecting bar, because a
 * blank rectangle hides the only thing the person can still see.
 */
@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DesktopScreen(
    title: String,
    viewerUrl: String,
    handover: Boolean,
    onBack: () -> Unit,
) {
    val colors = LocalEacbotColors.current
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var zoom by remember { mutableStateOf(1f) }
    var clipboardOpen by remember { mutableStateOf(false) }
    var keyboardText by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }

    DisposableEffect(viewerUrl) {
        onDispose {
            webView?.let { view ->
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
            }
            webView = null
        }
    }

    LaunchedEffect(webView, viewerUrl) {
        webView?.let { view ->
            if (view.url != viewerUrl) view.loadUrl(viewerUrl)
        }
    }

    Scaffold(
        containerColor = colors.canvas,
        topBar = {
            PageHeader(
                title = title,
                subtitle = when {
                    failed -> "已断开连接，重试前保留最后画面"
                    loading -> "正在连接你的电脑"
                    else -> "实时"
                },
                subtitleColor = when {
                    failed -> colors.attention
                    loading -> colors.inkMuted
                    else -> colors.success
                },
                onBack = onBack,
                actions = {
                    Box {
                        CircleButton(Icons.Filled.MoreHoriz, "更多操作", { menuOpen = true })
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("放大") },
                                leadingIcon = { Icon(Icons.Filled.ZoomIn, null) },
                                onClick = { zoom = (zoom + 0.1f).coerceAtMost(1.6f) },
                            )
                            DropdownMenuItem(
                                text = { Text("缩小") },
                                leadingIcon = { Icon(Icons.Filled.ZoomOut, null) },
                                onClick = { zoom = (zoom - 0.1f).coerceAtLeast(0.6f) },
                            )
                            DropdownMenuItem(
                                text = { Text("剪贴板") },
                                leadingIcon = { Icon(Icons.Filled.ContentPaste, null) },
                                onClick = { menuOpen = false; clipboardOpen = true },
                            )
                            DropdownMenuItem(
                                text = { Text("全屏") },
                                leadingIcon = { Icon(Icons.Filled.Fullscreen, null) },
                                onClick = {
                                    menuOpen = false
                                    webView?.evaluateJavascript("document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()", null)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("重新连接") },
                                leadingIcon = { Icon(Icons.Filled.Refresh, null) },
                                onClick = { menuOpen = false; webView?.reload(); failed = false },
                            )
                        }
                    }
                },
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().background(colors.canvas).navigationBarsPadding().imePadding()) {
                if (handover) {
                    NoticeBanner("你正在控制这台电脑，交回控制权前智能体保持暂停。", tone = StatusTone.Waiting)
                }
                MessageComposer(
                    text = keyboardText,
                    change = { keyboardText = it },
                    send = {
                        if (keyboardText.isNotEmpty()) {
                            copyToClipboard(context, keyboardText)
                            keyboardText = ""
                        }
                    },
                    hint = "输入文字，复制到桌面剪贴板",
                )
            }
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .background(colors.code),
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.mediaPlaybackRequiresUserGesture = true
                        settings.builtInZoomControls = false
                        settings.displayZoomControls = false
                        settings.setSupportZoom(false)
                        // The viewer is served by the core itself, so it shares
                        // the core's origin and needs no cross-origin escape.
                        webChromeClient = object : WebChromeClient() {
                            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                                loading = newProgress < 100
                            }
                        }
                        webViewClient = object : WebViewClient() {
                            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                loading = true
                                failed = false
                            }

                            override fun onPageFinished(view: WebView?, url: String?) {
                                loading = false
                                view?.evaluateJavascript(
                                    "document.documentElement.style.zoom='${zoom}';",
                                    null,
                                )
                            }

                            override fun onReceivedError(
                                view: WebView?,
                                request: WebResourceRequest?,
                                error: android.webkit.WebResourceError?,
                            ) {
                                failed = true
                                loading = false
                            }

                            override fun shouldOverrideUrlLoading(
                                view: WebView?,
                                request: WebResourceRequest?,
                            ): Boolean {
                                // Stay inside the core's own origin: a link out of
                                // it is not part of this viewer.
                                val target = request?.url ?: return true
                                return target.toString().substringBefore("/", "").let { scheme ->
                                    scheme != viewerUrl.substringBefore("/", "")
                                }
                            }
                        }
                        loadUrl(viewerUrl)
                        webView = this
                    }
                },
                update = { view ->
                    webView = view
                    view.evaluateJavascript("document.documentElement.style.zoom='${zoom}';", null)
                },
            )

            if (loading && !failed) {
                Box(
                    Modifier
                        .align(Alignment.TopCenter)
                        .padding(12.dp)
                        .background(colors.surfaceRaised, RoundedCornerShape(percent = 50))
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = colors.accent)
                        Text("连接中", style = MaterialTheme.typography.labelSmall, color = colors.inkMuted)
                    }
                }
            }
            if (failed) {
                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .padding(12.dp)
                        .background(colors.surface, RoundedCornerShape(EacbotDimens.cardRadius))
                        .padding(12.dp),
                ) {
                    Text("连接已中断。", style = MaterialTheme.typography.bodyMedium, color = colors.ink)
                    Text(
                        "最后画面会保留，电脑恢复连接后请重试。",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.inkMuted,
                    )
                    TextButton(onClick = { webView?.reload(); failed = false }) { Text("重试") }
                }
            }
        }
    }

    if (clipboardOpen) {
        ClipboardDialog(
            onDismiss = { clipboardOpen = false },
            onCopyToDesktop = { text ->
                copyToClipboard(context, text)
                clipboardOpen = false
            },
            onReadFromDevice = {
                val text = readClipboard(context)
                clipboardOpen = false
                if (text != null) keyboardText = text
            },
        )
    }
}

@Composable
private fun ClipboardDialog(
    onDismiss: () -> Unit,
    onCopyToDesktop: (String) -> Unit,
    onReadFromDevice: () -> Unit,
) {
    val colors = LocalEacbotColors.current
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surface,
        title = { Text("剪贴板", style = MaterialTheme.typography.titleMedium, color = colors.ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "文字会放入系统剪贴板供桌面查看器读取，不会发送到服务器。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.inkMuted,
                )
                OutlinedTextField(
                colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                    unfocusedContainerColor = colors.surfaceRaised, focusedContainerColor = colors.surface,
                    unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent, focusedBorderColor = colors.inkMuted,
                ),
                    value = text,
                    onValueChange = { text = it },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(EacbotDimens.controlRadius),
                )
                TextButton(onClick = onReadFromDevice) { Text("使用此手机的剪贴板") }
            }
        },
        confirmButton = { TextButton(onClick = { onCopyToDesktop(text) }) { Text("拷贝") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

private fun copyToClipboard(context: Context, text: String) {
    val manager = context.getSystemService(ClipboardManager::class.java) ?: return
    manager.setPrimaryClip(ClipData.newPlainText("EACbot", text))
}

private fun readClipboard(context: Context): String? {
    val manager = context.getSystemService(ClipboardManager::class.java) ?: return null
    val clip = manager.primaryClip ?: return null
    if (clip.itemCount == 0) return null
    return clip.getItemAt(0).coerceToText(context)?.toString()
}
