// The platform's web gateway signs every call as md5(token & t & appKey & data). The token is the first half of
// the `_m_h5_tk` cookie, and `t` is the request's second timestamp; a call whose signature is stale is refused
// with a token error, which is how a lapsed cookie announces itself.
import { createHash } from "node:crypto";

/** The h5 gateway's app key, as the web client sends it. */
export const H5_APP_KEY = "12574478";
/** The IM gateway's app key; a different value reaches a different service. */
export const IM_APP_KEY = "34839810";

export const GOOFISH_ORIGIN = "https://www.goofish.com";
export const H5_API = "https://h5api.m.goofish.com/h5";

export function sign(token, timestamp, data, appKey = H5_APP_KEY) {
  return createHash("md5").update(`${token}&${timestamp}&${appKey}&${data}`).digest("hex");
}

/** Reads one cookie without decoding it: the gateway compares the raw value. */
export function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie ?? "");
  return match ? match[1] : null;
}

/** The half of `_m_h5_tk` before its underscore is the signing token; the rest is its expiry. */
export function signToken(cookie) {
  const raw = cookieValue(cookie, "_m_h5_tk");
  return raw ? raw.split("_")[0] : "";
}

/** The signed-in account's numeric id, which the gateway carries in `unb`. */
export function userId(cookie) {
  return cookieValue(cookie, "unb") ?? cookieValue(cookie, "tracknick") ?? null;
}

/**
 * A token error means the cookie pair the caller held is no longer the one the gateway accepts: the response
 * carries a fresh `_m_h5_tk`, and the call is worth exactly one retry with it.
 */
export function isTokenError(ret) {
  const code = Array.isArray(ret) ? String(ret[0] ?? "") : String(ret ?? "");
  return code.includes("FAIL_SYS_TOKEN") || code.includes("TOKEN_EXOIRED") || code.includes("TOKEN_EMPTY");
}

/** Merges `set-cookie` lines from a gateway answer back into the cookie the caller keeps. */
export function mergeCookies(cookie, setCookieLines) {
  const jar = new Map();
  for (const part of String(cookie ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    jar.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  for (const line of setCookieLines ?? []) {
    const [pair] = String(line).split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === "" || /^(?:EXPIRED|deleted)$/i.test(value)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function setCookieLines(headers) {
  const raw = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (raw?.length) return raw;
  const single = headers?.get?.("set-cookie");
  return single ? [single] : [];
}

/**
 * One signed POST to the gateway. The answer is the gateway's JSON body; a non-zero `ret` is returned rather
 * than thrown, because callers differ on which codes are recoverable.
 */
export async function signedPost({ path, appKey = H5_APP_KEY, cookie, data, timeoutMs = 15_000, fetchImpl = fetch }) {
  const payload = typeof data === "string" ? data : JSON.stringify(data ?? {});
  const token = signToken(cookie);
  if (!token) throw Object.assign(new Error("the cookie is missing _m_h5_tk, so requests cannot be signed"), { code: "no-login" });
  const timestamp = String(Date.now());
  const signature = sign(token, timestamp, payload, appKey);
  const url = `${H5_API}/${path}/1.0/${timestamp}/${appKey}/${signature}/`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: GOOFISH_ORIGIN,
      referer: `${GOOFISH_ORIGIN}/`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      cookie,
    },
    body: new URLSearchParams({ data: payload }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("the gateway answered with something that is not JSON"), { code: "bad-response", retryable: true });
  }
  return { status: response.status, body: parsed, cookies: setCookieLines(response.headers) };
}
