package com.eacbot.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.eacbot.mobile.data.CoreConnection
import com.eacbot.mobile.data.SessionStore
import com.eacbot.mobile.notify.NotificationPresenter

/**
 * One connection, one credential store, one notifier for the whole process.
 *
 * The app has no dependency-injection graph because it has exactly one of each:
 * a second [CoreConnection] would be a second live stream against the same
 * core, and a second [SessionStore] would mean two places that can disagree
 * about whether this phone is paired.
 */
class EacbotApplication : Application() {

    lateinit var sessions: SessionStore
        private set

    lateinit var connection: CoreConnection
        private set

    lateinit var notifications: NotificationPresenter
        private set

    override fun onCreate() {
        super.onCreate()
        sessions = SessionStore(this)
        notifications = NotificationPresenter(this)
        connection = CoreConnection(
            sessions = sessions,
            onNotification = { notifications.show(it) },
        )
        createChannels()
        connection.restore()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            NotificationPresenter.CHANNEL_ID,
            "智能体活动",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "智能体需要你处理或完成任务时通知"
            // A lock screen shows the mission title and a fixed phrase, never
            // the prompt, a tool's input or an approval's detail.
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }
}
