import { describe, expect, it } from "vitest";

import { createVipEntitlement } from "./vip.ts";
import { KugouRequest, KugouTransport } from "./transport.ts";

const SESSION = {
  current: () => ({ userId: "42", token: "t" }),
  device: () => ({ dfid: "d", mid: "m", userId: "42", token: "t" }),
};

function fakeTransport(answer: (path: string) => Record<string, unknown> | null): KugouTransport & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async request<T>(request: KugouRequest): Promise<T> {
      paths.push(new URL(request.url).pathname);
      const payload = answer(new URL(request.url).pathname);
      if (!payload) throw new Error(`unexpected call to ${new URL(request.url).pathname}`);
      return payload as T;
    },
    async bytes() {
      return new Uint8Array();
    },
  };
}

describe("createVipEntitlement", () => {
  it("claims the day, waits, then upgrades, when today has no record", async () => {
    const waits: number[] = [];
    const transport = fakeTransport((path) => {
      if (path.endsWith("get_month_vip_record")) return { status: 1, items: [{ day: "2026-01-01", vip_type: "vip" }] };
      if (path.endsWith("receive_vip_listen_song")) return { status: 1 };
      if (path.endsWith("upgrade_vip_reward")) return { status: 1 };
      return null;
    });
    const vip = createVipEntitlement({
      transport,
      session: SESSION,
      delay: async (ms) => { waits.push(ms); },
      today: () => "2026-11-21",
    });
    const result = await vip.ensureDailyVip();
    expect(result.outcome).toBe("received");
    expect(waits).toEqual([1_000]);
    expect(transport.paths).toEqual([
      expect.stringContaining("get_month_vip_record"),
      expect.stringContaining("receive_vip_listen_song"),
      expect.stringContaining("upgrade_vip_reward"),
    ]);
  });

  it("only upgrades when today's record is a concept-VIP claim", async () => {
    const transport = fakeTransport((path) => {
      if (path.endsWith("get_month_vip_record")) return { status: 1, items: [{ day: "2026-11-21", vip_type: "tvip" }] };
      if (path.endsWith("upgrade_vip_reward")) return { status: 1 };
      return null;
    });
    const vip = createVipEntitlement({ transport, session: SESSION, delay: async () => {}, today: () => "2026-11-21" });
    const result = await vip.ensureDailyVip();
    expect(result.outcome).toBe("already");
    expect(transport.paths.some((path) => path.endsWith("upgrade_vip_reward"))).toBe(true);
    expect(transport.paths.some((path) => path.endsWith("receive_vip_listen_song"))).toBe(false);
  });

  it("reports already when the day is claimed and is a plain VIP", async () => {
    const transport = fakeTransport((path) => {
      if (path.endsWith("get_month_vip_record")) return { status: 1, items: [{ day: "2026-11-21", vip_type: "vip" }] };
      return null;
    });
    const vip = createVipEntitlement({ transport, session: SESSION, delay: async () => {}, today: () => "2026-11-21" });
    expect((await vip.ensureDailyVip()).outcome).toBe("already");
  });

  it("fails with a typed reason when the record lookup is refused", async () => {
    const transport = fakeTransport((path) => {
      if (path.endsWith("get_month_vip_record")) return { status: 0, error_code: 7 };
      return null;
    });
    const vip = createVipEntitlement({ transport, session: SESSION, delay: async () => {}, today: () => "2026-11-21" });
    const result = await vip.ensureDailyVip();
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("history_unavailable");
    expect(result.errorCode).toBe(7);
  });
});
