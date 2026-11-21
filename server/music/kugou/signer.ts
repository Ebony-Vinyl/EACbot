// Kugou's request signatures. The salts are published constants of the public
// web/desktop clients (KugouMusic.NET, MIT, mirrors them); they are not secrets
// and rotating them is a change to the upstream protocol, not to this file.
import { createHash } from "node:crypto";

/** The Lite client (appid 3116) most endpoints sign with. */
export const LITE_SALT = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
/** Appended to a play-url signature: hash + salt + appid + mid + userid. */
export const V5_KEY_SALT = "185672dd44712f60bb1736df5a377e82";
/** The web client's salt, for the QR login pair. */
export const WEB_SIGNATURE_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
/** The Android official client's salt, for fingerprint matching. */
export const OFFICIAL_SALT = "OIlwieks28dk2k092lksi2UIkp";

export const LITE_APP_ID = "3116";
export const LITE_CLIENT_VER = "11440";
export const OFFICIAL_APP_ID = "1005";
export const OFFICIAL_CLIENT_VER = "20489";
/** The play-url endpoint was built for this client version; it rejects others. */
export const PLAY_CLIENT_VER = "11430";

export function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** Ordinal order, as the upstream signer sorts: byte order, not locale collation. */
function sortedPairs(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .map((key) => `${key}=${params[key]}`)
    .join("");
}

/**
 * The Lite signature: salt, the sorted query string, the raw body, salt again.
 * A GET has an empty body. `body` is the exact bytes sent, so a JSON body is
 * signed as serialized rather than re-encoded.
 */
export function liteSignature(params: Readonly<Record<string, string>>, body = ""): string {
  return md5(`${LITE_SALT}${sortedPairs(params)}${body}${LITE_SALT}`);
}

/** The web client's signature: the same sorted pairs between two web salts. */
export function webSignature(params: Readonly<Record<string, string>>): string {
  return md5(`${WEB_SIGNATURE_SALT}${sortedPairs(params)}${WEB_SIGNATURE_SALT}`);
}

/** The play-url signature. `userId` is 0 when signed out. */
export function v5Signature(hash: string, mid: string, userId: string): string {
  return md5(`${hash.toLowerCase()}${V5_KEY_SALT}${LITE_APP_ID}${mid}${userId}`);
}

/** The Android official client's signature, for fingerprint matching. */
export function officialSignature(params: Readonly<Record<string, string>>): string {
  return md5(`${OFFICIAL_SALT}${sortedPairs(params)}${OFFICIAL_SALT}`);
}

/**
 * The login key: appid, salt, client version and the client time in ms. The
 * login and refresh endpoints take this instead of a query signature.
 */
export function loginKey(clientTimeMs: number): string {
  return md5(`${LITE_APP_ID}${LITE_SALT}${LITE_CLIENT_VER}${clientTimeMs}`);
}

/** A device fingerprint id: 24 lowercase hex characters, stable per install. */
export function randomDfid(random: () => number = Math.random): string {
  const bytes = new Uint8Array(12);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The `mid` a client derives from its dfid: md5 of the dfid, upper-cased. The
 * play-url and login endpoints both key on it, so it must be stable.
 */
export function midFromDfid(dfid: string): string {
  return md5(dfid).toUpperCase();
}

/** `uuid`: md5 of dfid + mid, as the official client sends it. */
export function uuidFromDfid(dfid: string, mid: string): string {
  return md5(`${dfid}${mid}`).toUpperCase();
}
