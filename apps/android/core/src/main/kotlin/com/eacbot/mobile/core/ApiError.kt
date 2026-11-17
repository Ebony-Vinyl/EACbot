package com.eacbot.mobile.core

import kotlinx.serialization.json.JsonObject

/**
 * The wire error envelope: every failure the core sends uses one shape
 * (`core/http/errors.ts`), so a client has exactly one parser.
 */
data class ApiErrorDetails(
    val code: String,
    val message: String,
    val requestId: String? = null,
    /** Present on a `revision_conflict`: the revision the server actually holds,
     * so the caller can refetch instead of retrying blind. */
    val currentRevision: Int? = null,
    val expectedRevision: Int? = null,
    val actualRevision: Int? = null,
)

class ApiException(
    val status: Int,
    val details: ApiErrorDetails,
    cause: Throwable? = null,
) : Exception("${details.code}: ${details.message}", cause) {

    /** A 401 means the bearer is gone, expired or revoked. The app answers by
     * clearing the stored credential and returning to pairing; it never retries
     * with the same token. */
    val isUnauthenticated: Boolean get() = status == 401

    /** A 403 is a scope refusal, not a lost session: re-pairing would not help. */
    val isForbidden: Boolean get() = status == 403

    val isRevisionConflict: Boolean get() = details.code == "revision_conflict"
}

/** A transport failure: no HTTP status was received at all. */
class NetworkException(message: String, cause: Throwable? = null) : Exception(message, cause)

object ErrorCodec {

    fun parse(status: Int, body: JsonObject?): ApiException {
        val error = body?.objectOrNull("error")
        if (error == null) {
            return ApiException(status, ApiErrorDetails(code = fallbackCode(status), message = fallbackMessage(status)))
        }
        val details = error.objectOrNull("details")
        return ApiException(
            status = status,
            details = ApiErrorDetails(
                code = error.stringOrNull("code") ?: fallbackCode(status),
                message = error.stringOrNull("message") ?: fallbackMessage(status),
                requestId = details?.stringOrNull("requestId"),
                currentRevision = details?.intOrNull("currentRevision"),
                expectedRevision = details?.intOrNull("expected"),
                actualRevision = details?.intOrNull("actual"),
            ),
        )
    }

    private fun fallbackCode(status: Int): String = when (status) {
        400 -> "invalid_request"
        401 -> "unauthenticated"
        403 -> "forbidden"
        404 -> "not_found"
        409 -> "conflict"
        422 -> "capability_missing"
        429 -> "too_many_requests"
        else -> if (status >= 500) "internal_error" else "error"
    }

    private fun fallbackMessage(status: Int): String = when (status) {
        401 -> "this device is no longer signed in"
        403 -> "this device is not allowed to do that"
        404 -> "the server does not have that"
        409 -> "the server's state moved on"
        else -> "the request failed with status $status"
    }
}
