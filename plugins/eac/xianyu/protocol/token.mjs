// The IM access token, and the cookie it is minted against.
//
// The message gateway does not take the web cookie directly: it wants a short-lived token obtained from the
// IM token endpoint. The token expires, and when it does the gateway closes the socket with a token error
// rather than an authentication one, so the line asks for a new token once and reconnects.
import { IM_APP_KEY, isTokenError, mergeCookies, signedPost } from "./sign.mjs";

const TOKEN_PATH = "mtop.taobao.idlemessage.pc.login.token";
/** A token is minted well before it is needed; a stale one is re-minted instead of failing a message. */
const TOKEN_SAFETY_MS = 10 * 60_000;

export function extractToken(body) {
  const data = body?.data ?? body;
  const token = data?.accessToken ?? data?.access_token ?? data?.token;
  return typeof token === "string" && token ? token : null;
}

export function tokenExpiry(body) {
  const data = body?.data ?? body;
  const expires = Number(data?.expireTime ?? data?.expire_time ?? data?.expiresIn);
  if (!Number.isFinite(expires) || expires <= 0) return Date.now() + 60 * 60_000;
  // The endpoint reports either an epoch in milliseconds or a lifetime in seconds; both appear in traffic.
  return expires > 1e12 ? expires : Date.now() + expires * 1_000;
}

export function createTokenSource({ getCookie, setCookie, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;

  return {
    /** The token to open a socket with, minted when the cached one is missing or near its end. */
    async token({ force = false } = {}) {
      if (!force && cached && cached.expiresAt - TOKEN_SAFETY_MS > now()) return cached.token;
      const cookie = await getCookie();
      if (!cookie) throw Object.assign(new Error("no Xianyu cookie is configured"), { code: "no-login" });
      let answer;
      try {
        answer = await signedPost({ path: TOKEN_PATH, appKey: IM_APP_KEY, cookie, data: {}, fetchImpl });
      } catch (error) {
        throw Object.assign(new Error(`the token endpoint is unreachable: ${error.message}`), { code: "unreachable", retryable: true });
      }
      if (answer.cookies.length) await setCookie(answer.cookies);
      const ret = answer.body?.ret;
      if (isTokenError(ret)) {
        throw Object.assign(new Error("the cookie was refused while minting a token; sign in again"), { code: "session-expired" });
      }
      const token = extractToken(answer.body);
      if (!token) {
        const said = Array.isArray(ret) ? ret.join(" ") : String(ret ?? "");
        throw Object.assign(new Error(`the token endpoint returned no token${said ? `: ${said}` : ""}`), { code: "no-token" });
      }
      cached = { token, expiresAt: tokenExpiry(answer.body) };
      return token;
    },
    /** Called when the socket reports a token error: the next `token()` must not reuse the cached one. */
    invalidate() {
      cached = null;
    },
    peek() {
      return cached ? { expiresAt: cached.expiresAt, live: cached.expiresAt - TOKEN_SAFETY_MS > now() } : null;
    },
  };
}

export { mergeCookies };
