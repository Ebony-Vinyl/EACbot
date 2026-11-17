package com.eacbot.mobile

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.eacbot.mobile.data.SessionStore
import com.eacbot.mobile.legacy.LegacyScreen
import com.eacbot.mobile.legacy.LegacyViewModel
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.eacbot.mobile.data.CoreConnection
import com.eacbot.mobile.data.SessionPhase
import com.eacbot.mobile.desktop.DesktopScreen
import com.eacbot.mobile.design.EacbotTheme
import com.eacbot.mobile.terminal.TerminalScreen
import com.eacbot.mobile.terminal.TerminalViewModel
import com.eacbot.mobile.ui.PairingScreen
import com.eacbot.mobile.ui.SignedOutScreen
import com.eacbot.mobile.ui.agents.AgentsScreen
import com.eacbot.mobile.ui.agents.AgentsViewModel
import com.eacbot.mobile.ui.chat.ChatScreen
import com.eacbot.mobile.ui.chat.ChatViewModel
import com.eacbot.mobile.ui.computer.ComputerScreen
import com.eacbot.mobile.ui.computer.ComputerViewModel
import com.eacbot.mobile.ui.home.HomeScreen
import com.eacbot.mobile.ui.home.NewMissionScreen
import com.eacbot.mobile.ui.home.NewMissionViewModel
import com.eacbot.mobile.ui.settings.SettingsScreen
import com.eacbot.mobile.ui.settings.SettingsViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as EacbotApplication
        setContent {
            EacbotTheme {
                val preferences = remember { getSharedPreferences("eacbot-backend", Context.MODE_PRIVATE) }
                var legacy by remember { mutableStateOf(preferences.getBoolean("legacy", true)) }
                val legacyModel = viewModel { LegacyViewModel(SessionStore(applicationContext, "eacbot-legacy-session")) }
                Column(Modifier.fillMaxSize().statusBarsPadding()) {
                    TextButton(onClick = {
                        legacy = !legacy
                        preferences.edit().putBoolean("legacy", legacy).apply()
                    }) { Text(if (legacy) "EACbot · 切换到任务中心" else "任务中心 · 切换到 EACbot") }
                    Box(Modifier.weight(1f)) {
                        if (legacy) LegacyScreen(legacyModel)
                        else EacbotShell(connection = app.connection, sessions = app.sessions)
                    }
                }
            }
        }
    }
}

/** The whole app: pairing, or the phone's own three-level structure
 * (list → conversation → that bot's computer). */
@Composable
private fun EacbotShell(connection: CoreConnection, sessions: com.eacbot.mobile.data.SessionStore) {
    val phase by connection.phase.collectAsStateWithLifecycle()
    val missions by connection.missions.collectAsStateWithLifecycle()
    val stream by connection.stream.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> connection.setForeground(true)
                Lifecycle.Event.ON_STOP -> connection.setForeground(false)
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val current = phase
    when (current) {
        SessionPhase.NeedsPairing, is SessionPhase.SignedOut -> {
            val notice = (current as? SessionPhase.SignedOut)?.reason
            PairingScreen(
                defaultLabel = defaultLabel(),
                notice = notice,
                onPair = { baseUrl, code, label ->
                    val result = connection.pair(baseUrl, code, label)
                    result.map { }
                },
            )
        }
        is SessionPhase.Connecting, is SessionPhase.Live -> {
            val api = connection.currentApi()
            if (api == null) {
                SignedOutScreen("无法打开连接", onPairAgain = { connection.forgetDevice() })
                return
            }
            NavHost(navController = nav, startDestination = Routes.Home) {
                composable(Routes.Home) {
                    HomeScreen(
                        missions = missions,
                        streamConnected = stream.connected,
                        offlineNote = null,
                        onOpenMission = { nav.navigate("${Routes.Chat}/$it") },
                        onCreate = { nav.navigate(Routes.NewMission) },
                        onOpenSettings = { nav.navigate(Routes.Settings) },
                        onOpenAgents = { nav.navigate(Routes.Agents) },
                        onRefresh = connection::refreshMissions,
                    )
                }
                composable(Routes.NewMission) {
                    val viewModel = remember { NewMissionViewModel(api) }
                    NewMissionScreen(
                        viewModel = viewModel,
                        onBack = { nav.popBackStack() },
                        onCreated = { missionId ->
                            nav.popBackStack(Routes.Home, inclusive = false)
                            nav.navigate("${Routes.Chat}/$missionId")
                        },
                    )
                }
                composable(
                    route = "${Routes.Chat}/{missionId}",
                    arguments = listOf(navArgument("missionId") { type = NavType.StringType }),
                ) { entry ->
                    val missionId = entry.arguments?.getString("missionId").orEmpty()
                    val viewModel = remember(missionId) { ChatViewModel(api, missionId, hints = connection.notifications) }
                    DisposableEffect(missionId) {
                        onDispose { viewModel.stop() }
                    }
                    ChatScreen(
                        title = missions[missionId]?.title ?: "任务",
                        viewModel = viewModel,
                        onBack = { nav.popBackStack() },
                        onOpenComputer = { nav.navigate("${Routes.Computer}/$missionId") },
                    )
                }
                composable(
                    route = "${Routes.Computer}/{missionId}",
                    arguments = listOf(navArgument("missionId") { type = NavType.StringType }),
                ) { entry ->
                    val missionId = entry.arguments?.getString("missionId").orEmpty()
                    val viewModel = remember(missionId) { ComputerViewModel(api, missionId) }
                    ComputerScreen(
                        missionTitle = missions[missionId]?.title ?: "任务",
                        viewModel = viewModel,
                        onBack = { nav.popBackStack() },
                        onOpenTerminal = { nav.navigate("${Routes.Terminal}/$it") },
                        onOpenDesktop = { url ->
                            nav.navigate("${Routes.Desktop}/${java.net.URLEncoder.encode(url, "UTF-8")}")
                        },
                    )
                }
                composable(
                    route = "${Routes.Desktop}/{url}",
                    arguments = listOf(navArgument("url") { type = NavType.StringType }),
                ) { entry ->
                    val url = java.net.URLDecoder.decode(entry.arguments?.getString("url").orEmpty(), "UTF-8")
                    DesktopScreen(
                        title = "你的电脑",
                        viewerUrl = url,
                        handover = true,
                        onBack = { nav.popBackStack() },
                    )
                }
                composable(Routes.Agents) {
                    val viewModel = remember { AgentsViewModel(api) }
                    AgentsScreen(
                        viewModel = viewModel,
                        onBack = { nav.popBackStack() },
                        onOpenMission = { nav.navigate("${Routes.Chat}/$it") },
                    )
                }
                composable(Routes.Settings) {
                    val viewModel = remember { SettingsViewModel(api, connection) }
                    SettingsScreen(viewModel = viewModel, onBack = { nav.popBackStack() })
                }
                composable(
                    route = "${Routes.Terminal}/{terminalId}",
                    arguments = listOf(navArgument("terminalId") { type = NavType.StringType }),
                ) { entry ->
                    val terminalId = entry.arguments?.getString("terminalId").orEmpty()
                    val viewModel = remember(terminalId) { TerminalViewModel(api, terminalId) }
                    DisposableEffect(terminalId) {
                        onDispose { viewModel.close() }
                    }
                    TerminalScreen(
                        title = "终端",
                        viewModel = viewModel,
                        onBack = { nav.popBackStack() },
                    )
                }
            }
        }
    }
}

object Routes {
    const val Home = "home"
    const val NewMission = "new"
    const val Agents = "agents"
    const val Settings = "settings"
    const val Chat = "chat"
    const val Computer = "computer"
    const val Terminal = "terminal"
    const val Desktop = "desktop"
}

/** What this phone calls itself in the core's device list. */
private fun defaultLabel(): String {
    val model = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android"
    return "$model 手机"
}
