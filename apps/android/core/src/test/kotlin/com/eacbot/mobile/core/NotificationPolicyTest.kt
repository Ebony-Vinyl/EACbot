package com.eacbot.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationPolicyTest {

    private fun decide(
        previous: MissionStatus?,
        current: MissionStatus?,
        foreground: Boolean = false,
        recent: Set<String> = emptySet(),
        title: String? = "Sort the inbox",
    ): NotificationDecision? = NotificationPolicy.decide(
        missionId = "m-1",
        missionTitle = title,
        previous = previous,
        current = current,
        runId = "r-1",
        appInForeground = foreground,
        recentlyNotified = recent,
    )

    @Test
    fun `an agent that starts waiting notifies`() {
        val decision = decide(MissionStatus.Running, MissionStatus.WaitingInput)
        assertNotNull(decision)
        assertEquals(NotificationDecision.NotificationKind.NeedsYou, decision!!.kind)
        assertEquals("Sort the inbox", decision.title)
        assertEquals("m-1", decision.missionId)
    }

    @Test
    fun `an agent that finishes without waiting notifies`() {
        val decision = decide(MissionStatus.Running, MissionStatus.Succeeded)!!
        assertEquals(NotificationDecision.NotificationKind.Finished, decision.kind)
        assertEquals("已完成", decision.body)
    }

    @Test
    fun `a failure notifies and says so without the error text`() {
        val decision = decide(MissionStatus.Running, MissionStatus.Failed)!!
        assertEquals(NotificationDecision.NotificationKind.Finished, decision.kind)
        assertEquals("因错误停止", decision.body)
    }

    @Test
    fun `a cancellation is not worth waking someone for`() {
        assertNull(decide(MissionStatus.Running, MissionStatus.Cancelled))
    }

    @Test
    fun `a state that was already true is not a new transition`() {
        assertNull(decide(MissionStatus.WaitingInput, MissionStatus.WaitingInput))
        assertNull(decide(MissionStatus.Succeeded, MissionStatus.Succeeded))
    }

    @Test
    fun `no notification while the app is in the foreground`() {
        assertNull(decide(MissionStatus.Running, MissionStatus.WaitingInput, foreground = true))
        assertNull(decide(MissionStatus.Running, MissionStatus.Succeeded, foreground = true))
    }

    @Test
    fun `a repeated notification inside the throttle window is suppressed`() {
        val key = "m-1:${NotificationDecision.NotificationKind.NeedsYou}"
        assertNull(decide(MissionStatus.Running, MissionStatus.WaitingInput, recent = setOf(key)))
    }

    @Test
    fun `the body never carries prompt text, tool input or approval detail`() {
        val decision = decide(MissionStatus.Running, MissionStatus.WaitingInput, title = "Rotate the API keys")!!
        assertEquals("等待你的回答", decision.body)
    }

    @Test
    fun `a blank mission title falls back to the agent name rather than an empty lock screen`() {
        val decision = NotificationPolicy.decide(
            missionId = "m-1",
            missionTitle = "   ",
            previous = MissionStatus.Running,
            current = MissionStatus.WaitingInput,
            runId = "r-1",
            appInForeground = false,
            recentlyNotified = emptySet(),
        )!!
        assertEquals("Hermes", decision.title)
    }

    @Test
    fun `a notification without a mission is not shown`() {
        assertNull(
            NotificationPolicy.decide(
                missionId = null,
                missionTitle = "x",
                previous = MissionStatus.Running,
                current = MissionStatus.WaitingInput,
                runId = null,
                appInForeground = false,
                recentlyNotified = emptySet(),
            ),
        )
    }

    @Test
    fun `an intermediate status does not notify`() {
        assertNull(decide(MissionStatus.Queued, MissionStatus.Provisioning))
        assertNull(decide(MissionStatus.Running, MissionStatus.WaitingChildren))
    }
}
