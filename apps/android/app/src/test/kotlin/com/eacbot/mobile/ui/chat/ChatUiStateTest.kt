package com.eacbot.mobile.ui.chat

import com.eacbot.mobile.core.*
import org.junit.Assert.*
import org.junit.Test

class ChatUiStateTest {
    @Test
    fun `composer refuses completed and interrupted missions`() {
        val mission = Mission("m", "m", null, 0, "title", "prompt", AgentKind.Hermes,
            "hermes", null, null, MissionStatus.Running, 1, "", "", "")
        assertTrue(ChatUiState(mission = mission).canSend)
        assertTrue(ChatUiState(mission = mission.copy(status = MissionStatus.WaitingInput)).canSend)
        listOf(MissionStatus.Succeeded, MissionStatus.Failed, MissionStatus.Cancelled, MissionStatus.Interrupted).forEach {
            assertFalse(ChatUiState(mission = mission.copy(status = it)).canSend)
        }
    }
}
