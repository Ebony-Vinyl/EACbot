// The daily listen-to-earn VIP chain: read this month's claim record, claim the
// day when it is missing, wait one second, then run the upgrade call. The three
// outcomes mirror upstream's VipEntitlementService — already claimed, claimed and
// upgraded, or a typed failure a caller logs without blocking playback.
import { KugouError, type KugouTransport } from "./transport.ts";

export const VIP_CLAIM_OUTCOMES = ["already", "received", "failed"] as const;
export type VipClaimOutcome = (typeof VIP_CLAIM_OUTCOMES)[number];

export interface VipClaimResult {
  outcome: VipClaimOutcome;
  /** Which leg failed and why, when the outcome is `failed`. */
  reason: "history_unavailable" | "receive_failed" | "upgrade_failed" | "not_signed_in" | null;
  /** Kugou's own error code for the failed leg, when it gave one. */
  errorCode: number | null;
}

export interface VipEntitlementOptions {
  transport: KugouTransport;
  session: { current(): { userId: string; token: string } | null; device(): { dfid: string; mid: string; userId: string; token: string } };
  /** Swappable so a test does not really wait. */
  delay?: (ms: number) => Promise<void>;
  /** Produces the `receive_day` the record lookup compares against. */
  today?: () => string;
}

function rowField(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

export function createVipEntitlement(options: VipEntitlementOptions) {
  const { transport, session } = options;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const today = options.today ?? (() => {
    const now = new Date();
    const month = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  });

  const claimParams = () => {
    const { dfid, mid, userId, token } = session.device();
    return { dfid, mid, userid: userId, token, appid: "3116", clientver: "11440" };
  };

  const upgrade = async (): Promise<{ ok: boolean; errorCode: number | null }> => {
    try {
      const payload = await transport.request<{ status?: number; error_code?: number; errcode?: number }>({
        url: "https://kugouvip.kugou.com/youth/v1/listen_song/upgrade_vip_reward",
        method: "POST",
        params: { ...claimParams(), kugouid: session.current()?.userId ?? "0", ad_type: "1" },
      });
      return { ok: Number(payload?.status ?? 0) === 1, errorCode: Number(payload?.error_code ?? payload?.errcode ?? 0) || null };
    } catch (error) {
      if (error instanceof KugouError && error.code === "expired_session") throw error;
      return { ok: false, errorCode: null };
    }
  };

  return {
    /** Runs at most one claim per call; safe to call again after a failure. */
    async ensureDailyVip(): Promise<VipClaimResult> {
      if (!session.current()?.token) return { outcome: "failed", reason: "not_signed_in", errorCode: null };
      let rows: unknown[] = [];
      try {
        const payload = await transport.request<{ data?: unknown; items?: unknown; records?: unknown; status?: number; error_code?: number }>({
          url: "https://kugouvip.kugou.com/youth/v1/activity/get_month_vip_record",
          params: { ...claimParams(), latest_limit: "100" },
        });
        if (Number(payload?.status ?? 0) !== 1) {
          return { outcome: "failed", reason: "history_unavailable", errorCode: Number(payload?.error_code ?? 0) || null };
        }
        rows = [payload?.items, payload?.records, (payload?.data as Record<string, unknown> | undefined)?.items]
          .find(Array.isArray) ?? [];
      } catch (error) {
        if (error instanceof KugouError && error.code === "expired_session") throw error;
        return { outcome: "failed", reason: "history_unavailable", errorCode: null };
      }

      const day = today();
      const todayRow = rows.find((row) => row && typeof row === "object" && rowField(row as Record<string, unknown>, "day", "Day") === day);
      const vipType = todayRow ? rowField(todayRow as Record<string, unknown>, "vip_type", "VipType") : "";
      if (todayRow && vipType !== "tvip") return { outcome: "already", reason: null, errorCode: null };

      let received = false;
      if (!todayRow) {
        try {
          const payload = await transport.request<{ status?: number; error_code?: number }>({
            url: "https://kugouvip.kugou.com/youth/v1/recharge/receive_vip_listen_song",
            method: "POST",
            params: { ...claimParams(), source_id: "90139", receive_day: day },
          });
          received = Number(payload?.status ?? 0) === 1;
          if (!received) {
            return { outcome: "failed", reason: "receive_failed", errorCode: Number(payload?.error_code ?? 0) || null };
          }
        } catch (error) {
          if (error instanceof KugouError && error.code === "expired_session") throw error;
          return { outcome: "failed", reason: "receive_failed", errorCode: null };
        }
        // Kugou needs the claim to settle before the upgrade call lands.
        await delay(1_000);
      }

      const upgraded = await upgrade();
      if (!upgraded.ok) return { outcome: "failed", reason: "upgrade_failed", errorCode: upgraded.errorCode };
      return { outcome: received ? "received" : "already", reason: null, errorCode: null };
    },
  };
}
