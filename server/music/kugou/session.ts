// The Kugou account: the QR and SMS sign-in flows, the token refresh, and the
// device fingerprint every signed request carries. The session file is the only
// place a token lives; it never enters config.json and never leaves this process.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MusicQuality } from "../../../shared/music.ts";
import { loginKey, md5, midFromDfid, randomDfid, uuidFromDfid } from "./signer.ts";
import { clientTimeMs, createKugouTransport, KugouError, liteQuery, type KugouTransport } from "./transport.ts";

/** Where the session file sits under the data directory. */
export const MUSIC_SESSION_FILE = "music-session.json";

/** A session as stored: the token plus what identifies the device that earned it. */
export interface KugouSession {
  userId: string;
  token: string;
  /** The refresh token the login endpoints return as `t1`. */
  t1: string;
  dfid: string;
  mid: string;
  uuid: string;
  nickname: string | null;
  avatarUrl: string | null;
  vip: boolean;
  vipLabel: string | null;
  /** The tier token Kugou hands back (`svip`/`tvip`/…), sent to FM and priv-url calls. */
  vipType: string | null;
  /** The paired VIP token some paid endpoints want beside the session token. */
  vipToken: string | null;
  /** What this account may play; `128k` for a signed-out or free account. */
  entitledQuality: MusicQuality;
  savedAt: string;
}

/** A QR code the person scans, plus the key the server polls with. */
export interface KugouQrCode {
  key: string;
  /** The URL the QR encodes. */
  url: string;
  expiresAt: string;
}

export const QR_STATUSES = ["waiting", "scanned", "expired", "success"] as const;
export type QrStatus = (typeof QR_STATUSES)[number];

export interface QrPoll {
  status: QrStatus;
  session?: KugouSession;
}

export interface KugouSessionOptions {
  dataDir: string;
  transport?: KugouTransport;
  now?: () => number;
  /** Called after a successful sign-in or refresh, so the host can broadcast. */
  changed?: (session: KugouSession | null) => void;
}

/**
 * AES-256-CBC with a key derived from a passphrase, as the login endpoints wrap
 * `secu_params`. The key is md5(passphrase); its last 16 characters are the IV.
 */
function aesKeyIv(passphrase: string): { key: Buffer; iv: Buffer } {
  const digest = md5(passphrase);
  return { key: Buffer.from(digest, "utf8"), iv: Buffer.from(digest.slice(16, 32), "utf8") };
}

/** Decrypts a hex `secu_params` payload into its JSON fields. A payload that will not decrypt is empty, not fatal. */
export function decryptSecuParams(hex: string, passphrase: string): Record<string, unknown> {
  try {
    const { key, iv } = aesKeyIv(passphrase);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The inverse, for a request that must send `secu_params`. */
export function encryptSecuParams(fields: Record<string, unknown>, passphrase: string): string {
  const { key, iv } = aesKeyIv(passphrase);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(JSON.stringify(fields), "utf8"), cipher.final()]).toString("hex");
}

/** Kugou reports the paid tier as a number; anything but zero is a paid account. */
function vipFromFields(fields: Record<string, unknown>): { vip: boolean; label: string | null } {
  const raw = fields.is_vip ?? fields.isVip ?? fields.vip;
  const tier = fields.vip_type ?? fields.vipType;
  const paid = typeof raw === "number" ? raw > 0 : typeof raw === "string" ? raw !== "0" && raw !== "" : false;
  const label = typeof tier === "string" && tier.trim() ? tier.trim().slice(0, 60)
    : typeof tier === "number" && tier > 0 ? (tier >= 2 ? "豪华VIP" : "VIP")
    : paid ? "VIP" : null;
  return { vip: paid || label !== null, label };
}

/** What an account may play. A free account still gets 128k, so the field is never "none". */
function entitledQualityFor(vip: boolean): MusicQuality {
  return vip ? "hires" : "320k";
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export interface KugouSessionManager {
  /** The stored session, or null when signed out. */
  current(): KugouSession | null;
  /** True when a token is present and not known to be expired. */
  signedIn(): boolean;
  /** The device fields every signed request needs; signed out still has a dfid. */
  device(): { dfid: string; mid: string; uuid: string; userId: string; token: string };
  /** Starts a QR sign-in: the code to show, and the key to poll. */
  startQr(): Promise<KugouQrCode>;
  pollQr(key: string): Promise<QrPoll>;
  /** Sends an SMS code to a mainland mobile number. */
  sendSmsCode(mobile: string): Promise<void>;
  /** Signs in with that code. `userId` disambiguates a number with several accounts. */
  loginWithCode(mobile: string, code: string, userId?: string): Promise<KugouSession>;
  /** Registers a new account with a code; Kugou answers with the same shape as a login. */
  register(mobile: string, code: string, password: string): Promise<KugouSession>;
  /** Refreshes the token; resolves null when the refresh itself failed and the person must sign in again. */
  refresh(): Promise<KugouSession | null>;
  signOut(): void;
  /** Reloads the account's profile and VIP state after a refresh or a quality change. */
  refreshProfile(): Promise<void>;
  refreshVip(): Promise<void>;
}

export function createKugouSessionManager(options: KugouSessionOptions): KugouSessionManager {
  const transport = options.transport ?? createKugouTransport();
  const now = options.now ?? (() => Date.now());
  const file = join(options.dataDir, MUSIC_SESSION_FILE);
  let session: KugouSession | null = null;
  let loaded = false;

  const load = (): KugouSession | null => {
    if (loaded) return session;
    loaded = true;
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<KugouSession>;
      if (typeof parsed?.token === "string" && typeof parsed.userId === "string" && typeof parsed.dfid === "string") {
        session = {
          userId: parsed.userId,
          token: parsed.token,
          t1: typeof parsed.t1 === "string" ? parsed.t1 : "",
          dfid: parsed.dfid,
          mid: typeof parsed.mid === "string" && parsed.mid ? parsed.mid : midFromDfid(parsed.dfid),
          uuid: typeof parsed.uuid === "string" && parsed.uuid ? parsed.uuid : uuidFromDfid(parsed.dfid, midFromDfid(parsed.dfid)),
          nickname: typeof parsed.nickname === "string" ? parsed.nickname : null,
          avatarUrl: typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : null,
          vip: parsed.vip === true,
          vipLabel: typeof parsed.vipLabel === "string" ? parsed.vipLabel : null,
          vipType: typeof parsed.vipType === "string" ? parsed.vipType : null,
          vipToken: typeof parsed.vipToken === "string" ? parsed.vipToken : null,
          entitledQuality: parsed.entitledQuality ?? entitledQualityFor(parsed.vip === true),
          savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(now()).toISOString(),
        };
      }
    } catch {
      session = null;
    }
    return session;
  };

  const save = (next: KugouSession | null): void => {
    session = next;
    loaded = true;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!next) {
      try {
        writeFileSync(file, "{}\n", { mode: 0o600 });
        chmodSync(file, 0o600);
      } catch { /* a read-only data dir must not crash a sign-out */ }
      options.changed?.(null);
      return;
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
    options.changed?.(next);
  };

  /** A dfid that survives a sign-out, so a re-login is the same device to Kugou. */
  const deviceDfid = (): string => load()?.dfid ?? storedDfid() ?? freshDfid();

  const storedDfid = (): string | null => {
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { dfid?: unknown };
      return typeof parsed.dfid === "string" && parsed.dfid.length >= 8 ? parsed.dfid : null;
    } catch {
      return null;
    }
  };

  const freshDfid = (): string => {
    const dfid = randomDfid();
    // Persist the fingerprint alone, so the next sign-in is recognised as this machine.
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({ dfid }, null, 2)}\n`, { mode: 0o600 });
    } catch { /* the device id is a nicety; a failed write only costs a new one */ }
    return dfid;
  };

  const sessionFromFields = (fields: Record<string, unknown>, fallbackDfid: string): KugouSession | null => {
    const token = str(fields.token);
    const userId = str(fields.userid ?? fields.user_id ?? fields.userId);
    if (!token || !userId) return null;
    const dfid = str(fields.dfid) && str(fields.dfid) !== "-" ? str(fields.dfid) : fallbackDfid;
    const mid = str(fields.mid) || midFromDfid(dfid);
    const { vip, label } = vipFromFields(fields);
    return {
      userId,
      token,
      t1: str(fields.t1),
      dfid,
      mid,
      uuid: str(fields.uuid) || uuidFromDfid(dfid, mid),
      nickname: str(fields.nickname) || str(fields.nick_name) || null,
      avatarUrl: str(fields.pic) || str(fields.avatar) || null,
      vip,
      vipLabel: label,
      vipType: str(fields.vip_type ?? fields.vipType) || null,
      vipToken: str(fields.vip_token ?? fields.vipToken) || null,
      entitledQuality: entitledQualityFor(vip),
      savedAt: new Date(now()).toISOString(),
    };
  };

  return {
    current: load,
    signedIn: () => {
      const current = load();
      return Boolean(current?.token && current.userId);
    },

    device: () => {
      const current = load();
      const dfid = current?.dfid ?? deviceDfid();
      const mid = current?.mid ?? midFromDfid(dfid);
      return {
        dfid,
        mid,
        uuid: current?.uuid ?? uuidFromDfid(dfid, mid),
        userId: current?.userId ?? "0",
        token: current?.token ?? "",
      };
    },

    async startQr() {
      const params: Record<string, string> = {
        appid: "1001",
        clientver: "11040",
        type: "1",
        plat: "4",
        srcappid: "2919",
        qrcode_txt: "https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&",
      };
      const payload = await transport.request<{ data?: { qrcode?: string; qrcode_img?: string }; status?: number; error?: string }>({
        url: "https://login-user.kugou.com/v2/qrcode",
        params,
        signature: "web",
      });
      const key = str(payload?.data?.qrcode);
      if (!key) throw new KugouError("source_unavailable", payload?.error || "Kugou did not return a QR code", true);
      return {
        key,
        url: str(payload?.data?.qrcode_img) || `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&qrcode=${encodeURIComponent(key)}`,
        expiresAt: new Date(now() + 180_000).toISOString(),
      };
    },

    async pollQr(key: string) {
      const payload = await transport.request<{ data?: Record<string, unknown>; status?: number }>({
        url: "https://login-user.kugou.com/v2/get_userinfo_qrcode",
        params: { plat: "4", appid: "3116", srcappid: "2919", qrcode: key },
        signature: "web",
      });
      const data = (payload?.data ?? {}) as Record<string, unknown>;
      const status = Number(data.status ?? payload?.status ?? 0);
      // 0 wait, 1 scanned-but-not-confirmed, 2 confirmed, 4 expired.
      if (status === 2) {
        const next = sessionFromFields(data, deviceDfid());
        if (!next) return { status: "waiting" as const };
        save(next);
        void this.refreshProfile();
        return { status: "success" as const, session: next };
      }
      if (status === 1) return { status: "scanned" as const };
      if (status === 4) return { status: "expired" as const };
      return { status: "waiting" as const };
    },

    async sendSmsCode(mobile: string) {
      if (!/^\d{6,15}$/.test(mobile.trim())) throw new KugouError("invalid_input", "a mobile number is digits only, e.g. 13800000000", false);
      const payload = await transport.request<{ status?: number; error?: string }>({
        url: "http://login.user.kugou.com/v7/send_mobile_code",
        method: "POST",
        router: "login.user.kugou.com",
        params: liteQuery(),
        body: new URLSearchParams({ businessid: "5", mobile: mobile.trim(), plat: "3" }).toString(),
      });
      if (Number(payload?.status ?? 1) !== 1) throw new KugouError("source_unavailable", payload?.error || "Kugou did not send the code", true);
    },

    async loginWithCode(mobile: string, code: string, userId?: string) {
      const clientTime = now();
      const dfid = deviceDfid();
      const body: Record<string, string> = {
        plat: "1",
        support_multi: "1",
        t1: "0",
        t2: "0",
        clienttime_ms: clientTimeMs(() => clientTime),
        mobile: mobile.trim(),
        key: loginKey(clientTime),
        pk: "",
        params: "",
        dfid: "-",
        dev: "2",
        gitversion: "5f0b7c4",
        code: code.trim(),
        ...(userId ? { userid: userId } : {}),
      };
      const payload = await transport.request<{ status?: number; error?: string; data?: Record<string, unknown>; secu_params?: string }>({
        url: "https://loginserviceretry.kugou.com/v7/login_by_verifycode",
        method: "POST",
        router: "login.user.kugou.com",
        params: liteQuery(),
        body: JSON.stringify(body),
        contentType: "application/json",
        headers: { "support-calm": "1" },
      });
      if (Number(payload?.status ?? 0) !== 1) {
        throw new KugouError(Number(payload?.status) === 2 ? "invalid_input" : "source_unavailable", payload?.error || "the code was refused; request a new one", false);
      }
      // A successful login wraps the account fields, sometimes behind secu_params.
      const decrypted = payload.secu_params ? decryptSecuParams(payload.secu_params, "56a2d4a0a4b1b4b7a0b1b2b3b4b5b6b7") : {};
      const fields = { ...payload.data, ...decrypted };
      const next = sessionFromFields(fields, dfid);
      if (!next) throw new KugouError("source_unavailable", "Kugou signed in but returned no token", false);
      save(next);
      void this.refreshProfile();
      return next;
    },

    async register(mobile: string, code: string, password: string) {
      const payload = await transport.request<{ status?: number; error?: string; data?: Record<string, unknown> }>({
        url: "https://loginserviceretry.kugou.com/v7/register_user",
        method: "POST",
        router: "login.user.kugou.com",
        params: liteQuery(),
        body: JSON.stringify({ plat: "1", mobile: mobile.trim(), code: code.trim(), password, clienttime_ms: clientTimeMs(now) }),
        contentType: "application/json",
      });
      if (Number(payload?.status ?? 0) !== 1) throw new KugouError("source_unavailable", payload?.error || "Kugou refused the registration", false);
      const next = sessionFromFields(payload.data ?? {}, deviceDfid());
      if (!next) throw new KugouError("source_unavailable", "Kugou registered the account but returned no token", false);
      save(next);
      void this.refreshProfile();
      return next;
    },

    async refresh() {
      const current = load();
      if (!current?.token) return null;
      const clientTime = now();
      const body = JSON.stringify({
        dfid: current.dfid || "-",
        p3: current.t1 || "",
        plat: "1",
        t1: current.t1 || "",
        t2: "0",
        t3: "MCwwLDAsMCwwLDAsMCwwLDA=",
        pk: "",
        params: "",
        userid: current.userId,
        clienttime_ms: clientTimeMs(() => clientTime),
        dev: "2",
      });
      try {
        const payload = await transport.request<{ status?: number; data?: Record<string, unknown> }>({
          url: "http://login.user.kugou.com/v5/login_by_token",
          method: "POST",
          router: "login.user.kugou.com",
          params: liteQuery(),
          body,
          contentType: "application/json",
        });
        if (Number(payload?.status ?? 0) !== 1) {
          save(null);
          return null;
        }
        const fields = { ...payload.data };
        const next = sessionFromFields({ ...fields, token: fields.token ?? current.token }, current.dfid);
        if (!next) {
          save(null);
          return null;
        }
        save({ ...next, nickname: next.nickname ?? current.nickname, avatarUrl: next.avatarUrl ?? current.avatarUrl });
        return next;
      } catch (error) {
        // A network failure is not an expired session; only a refusal clears it.
        if (error instanceof KugouError && error.code === "expired_session") save(null);
        throw error;
      }
    },

    signOut() {
      save(null);
    },

    /** Reads the union VIP state (`svip`/`tvip` included) and folds it into the stored tier. */
    async refreshVip() {
      const current = load();
      if (!current?.token) return;
      const { dfid, mid, userId, token } = this.device();
      try {
        const payload = await transport.request<{ data?: Record<string, unknown>; busi_vip?: unknown; is_vip?: unknown; vip_type?: unknown; status?: number }>({
          url: "https://kugouvip.kugou.com/v1/get_union_vip",
          params: { busi_type: "concept", dfid, mid, userid: userId, token, appid: "3116", clientver: "11440" },
        });
        const fields: Record<string, unknown> = { ...(payload?.data as object), is_vip: payload?.is_vip, vip_type: payload?.vip_type };
        const tiers = Array.isArray(payload?.busi_vip) ? payload.busi_vip as unknown[] : [];
        const superVip = tiers.some((tier) => (tier as Record<string, unknown>)?.product_type === "svip");
        const conceptVip = tiers.some((tier) => (tier as Record<string, unknown>)?.product_type === "tvip");
        const { vip, label } = vipFromFields(fields);
        const tierLabel = conceptVip ? "概念VIP" : superVip ? "豪华VIP" : label;
        save({
          ...current,
          vip: vip || superVip || conceptVip,
          vipLabel: tierLabel,
          vipType: superVip ? "svip" : conceptVip ? "tvip" : (current.vipType ?? null),
          entitledQuality: entitledQualityFor(vip || superVip || conceptVip),
        });
      } catch {
        // The tier is a display fact: a failure leaves the last known account state.
      }
    },

    async refreshProfile() {
      const current = load();
      if (!current?.token) return;
      const { dfid, mid, userId, token } = this.device();
      try {
        const payload = await transport.request<{ data?: Record<string, unknown>; status?: number }>({
          url: "https://kugou.com/youth/api/user/info",
          params: { dfid, mid, userid: userId, token, appid: "3116", clientver: "11440" },
        });
        const fields = (payload?.data ?? {}) as Record<string, unknown>;
        if (!fields || typeof fields !== "object") return;
        const { vip, label } = vipFromFields(fields);
        save({
          ...current,
          nickname: str(fields.nickname) || str(fields.nick_name) || current.nickname,
          avatarUrl: str(fields.pic) || str(fields.avatar) || current.avatarUrl,
          vip,
          vipLabel: label,
          entitledQuality: entitledQualityFor(vip),
        });
      } catch {
        // The profile is a nicety: a failure leaves the last known account state.
      }
    },
  };
}
