package com.eacbot.mobile.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.eacbot.mobile.MainActivity
import com.eacbot.mobile.R
import com.eacbot.mobile.core.NotificationDecision

/**
 * Task-finished and needs-you notifications, shown locally.
 *
 * There is no server push in this release: the app folds the live stream while
 * it is running and posts a local notification for the two transitions that
 * matter. A notification carries the mission title and a fixed phrase only;
 * the prompt, tool input and approval detail stay in the app, so a lock screen
 * cannot leak them. Tapping one opens that mission.
 */
class NotificationPresenter(private val context: Context) {

    private val manager: NotificationManager? =
        context.getSystemService(NotificationManager::class.java)

    fun show(decision: NotificationDecision) {
        if (!canPost()) return
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            decision.missionId?.let { putExtra(EXTRA_MISSION_ID, it) }
        }
        val pending = PendingIntent.getActivity(
            context,
            decision.missionId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_eacbot)
            .setContentTitle(decision.title)
            .setContentText(decision.body)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setCategory(Notification.CATEGORY_STATUS)
            .build()
        manager?.notify(decision.missionId?.hashCode() ?: 1, notification)
    }

    fun clearAll() {
        manager?.cancelAll()
    }

    private fun canPost(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    companion object {
        const val CHANNEL_ID = "agent-activity"
        const val EXTRA_MISSION_ID = "missionId"
    }
}

/**
 * Where a server-pushed notification would arrive.
 *
 * This release ships no push service, so the only implementation folds the
 * foreground stream. A later FCM receiver would call [LocalPushSink.offer]
 * with the same decision the policy already produces, which keeps the
 * redaction rules in one place.
 */
interface PushSink {
    fun offer(decision: NotificationDecision)
}

class LocalPushSink(private val presenter: NotificationPresenter) : PushSink {
    override fun offer(decision: NotificationDecision) = presenter.show(decision)
}
