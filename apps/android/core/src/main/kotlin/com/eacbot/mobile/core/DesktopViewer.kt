package com.eacbot.mobile.core

import okhttp3.HttpUrl

/**
 * The noVNC entry for the user's own computer.
 *
 * The phone never invents a viewer address. It asks the core, and the answer is
 * only usable when it is same-origin with the core and uses the core's own
 * scheme: a viewer URL that pointed somewhere else would turn this screen into
 * a browser for a third party, which is exactly what the app is not.
 */
sealed interface DesktopEntry {
    /** The core published a viewer at this address. */
    data class Ready(val url: HttpUrl, val label: String) : DesktopEntry

    /** The core answered, but has no desktop to show (no computer configured). */
    data class Unavailable(val reason: String) : DesktopEntry

    /** The core publishes no viewer route at all. */
    data object NotSupported : DesktopEntry

    /** The core sent an address this app will not load. */
    data class Refused(val reason: String) : DesktopEntry
}

object DesktopViewer {

    /** Path a core publishes its desktop entry on. */
    const val PATH = "/api/v1/desktop"

    /**
     * Decides whether a URL the core sent may be loaded in the viewer.
     *
     * `sameOrigin` compares scheme, host and port against the core's own base:
     * the core proxies its computer itself, so anything else is a redirect the
     * app must not follow.
     */
    fun validate(base: HttpUrl, candidate: String?, label: String? = null): DesktopEntry {
        if (candidate.isNullOrBlank()) {
            return DesktopEntry.Unavailable("the core reported no desktop viewer address")
        }
        val resolved = base.resolve(candidate)
            ?: return DesktopEntry.Refused("the address is not a URL")
        if (resolved.scheme != "http" && resolved.scheme != "https") {
            return DesktopEntry.Refused("the viewer must use http or https")
        }
        if (resolved.host != base.host || resolved.port != base.port) {
            return DesktopEntry.Refused("the viewer address is not on your core's own address")
        }
        if (base.isHttps && !resolved.isHttps) {
            return DesktopEntry.Refused("an https core cannot open an http viewer")
        }
        return DesktopEntry.Ready(resolved, label ?: "Your computer")
    }

    /**
     * Reads the core's answer. A 404 means the core has no such route, which is
     * a different fact from "no computer is configured", and the app says which
     * one it saw.
     */
    fun fromResponse(base: HttpUrl, body: kotlinx.serialization.json.JsonObject?): DesktopEntry {
        if (body == null) return DesktopEntry.NotSupported
        val error = body.objectOrNull("error")
        if (error != null) {
            return when (error.stringOrNull("code")) {
                "not_found", "not_implemented" -> DesktopEntry.NotSupported
                else -> DesktopEntry.Unavailable(error.stringOrNull("message") ?: "the core refused the viewer")
            }
        }
        return validate(
            base = base,
            candidate = body.stringOrNull("url") ?: body.stringOrNull("viewerUrl"),
            label = body.stringOrNull("label"),
        )
    }
}
