package com.eacbot.mobile.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.eacbot.mobile.core.TokenSource

/** What this phone remembers about the core it is paired with. */
data class PairedCore(
    val baseUrl: String,
    val label: String,
    val sessionId: String,
    val scope: String,
    val expiresAt: String,
    /** The cursor the app last folded, so a reconnect replays from there
     * instead of starting at "now". */
    val lastCursor: Long? = null,
)

/**
 * The one credential this app holds: a device bearer plus the core it belongs
 * to.
 *
 * The bearer is a durable secret, so it lives in
 * [EncryptedSharedPreferences] and never in plain preferences, a log line or a
 * URL. A 401 or a revocation clears the whole record, which is what sends the
 * app back to pairing.
 */
class SessionStore(context: Context, fileName: String = FILE_NAME) : TokenSource {

    private val prefs: SharedPreferences = runCatching {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            fileName,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ) as SharedPreferences
    }.getOrElse {
        // Without a usable keystore the honest answer is "nothing is stored":
        // falling back to plain preferences would put the bearer on disk in
        // cleartext, which is worse than asking the person to pair again.
        context.getSharedPreferences("$fileName-unusable", Context.MODE_PRIVATE).apply { edit().clear().apply() }
    }

    fun load(): PairedCore? {
        val token = prefs.getString(KEY_TOKEN, null)
        val baseUrl = prefs.getString(KEY_BASE_URL, null)
        if (token.isNullOrEmpty() || baseUrl.isNullOrEmpty()) return null
        return PairedCore(
            baseUrl = baseUrl,
            label = prefs.getString(KEY_LABEL, "") ?: "",
            sessionId = prefs.getString(KEY_SESSION_ID, "") ?: "",
            scope = prefs.getString(KEY_SCOPE, "device") ?: "device",
            expiresAt = prefs.getString(KEY_EXPIRES_AT, "") ?: "",
            lastCursor = prefs.getLong(KEY_CURSOR, -1L).takeIf { it >= 0L },
        )
    }

    fun save(core: PairedCore, token: String) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_BASE_URL, core.baseUrl)
            .putString(KEY_LABEL, core.label)
            .putString(KEY_SESSION_ID, core.sessionId)
            .putString(KEY_SCOPE, core.scope)
            .putString(KEY_EXPIRES_AT, core.expiresAt)
            .apply()
    }

    fun saveCursor(cursor: Long) {
        prefs.edit().putLong(KEY_CURSOR, cursor).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    override fun token(): String? = prefs.getString(KEY_TOKEN, null)

    /** The session this device holds, as the core lists it. */
    fun sessionId(): String? = prefs.getString(KEY_SESSION_ID, null)?.takeIf { it.isNotEmpty() }

    companion object {
        private const val FILE_NAME = "eacbot-session"
        private const val FILE_NAME_PLAIN = "eacbot-session-unusable"
        private const val KEY_TOKEN = "bearer"
        private const val KEY_BASE_URL = "baseUrl"
        private const val KEY_LABEL = "label"
        private const val KEY_SESSION_ID = "sessionId"
        private const val KEY_SCOPE = "scope"
        private const val KEY_EXPIRES_AT = "expiresAt"
        private const val KEY_CURSOR = "cursor"
    }
}
