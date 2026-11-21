import { describe, expect, it } from "vitest";

import { createPersonalFm, fmSongKey } from "./fm.ts";
import { KugouError, type KugouRequest, KugouTransport } from "./transport.ts";

const DEVICE = { dfid: "d", mid: "m", userId: "42", token: "t", vipType: "svip" };

function fmRow(name: string, hash: string, seconds = 180): Record<string, unknown> {
  return { songname: name, author_name: `singer of ${name}`, hash, time_length: seconds, album_id: `alb-${name}`, songid: 100 + name.length, privilege: 0 };
}

/** A fake station that answers every report with one fresh song. */
function fakeTransport(respond: (body: Record<string, unknown>) => Record<string, unknown>): KugouTransport & { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  return {
    bodies,
    async request<T>(_request: KugouRequest): Promise<T> {
      const body = JSON.parse(String(((_request as { body?: string }).body) ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      return respond(body) as T;
    },
    async bytes() {
      return new Uint8Array();
    },
  };
}

describe("createPersonalFm", () => {
  it("starts a session, keeps the preview small and tracks the pool in the report", async () => {
    let served = 0;
    const transport = fakeTransport(() => ({ song_list: [fmRow(`song ${served++}`, `h${served}`)] }));
    const fm = createPersonalFm({ transport, device: () => DEVICE });
    const state = await fm.start();
    expect(state.active).toBe(true);
    expect(state.current?.title).toBe("song 0");
    expect(state.upcoming.length).toBeLessThanOrEqual(4);
    expect(transport.bodies[0]!.song_pool_id).toBe(0);
    expect(transport.bodies[0]!.vip_type).toBe("svip");

    const flipped = fm.togglePool();
    expect(flipped.poolId).toBe("style");
    expect(fm.cycleMode().mode).toBe("small");
  });

  it("reports the finished play, advances, and never repeats a song", async () => {
    let served = 0;
    const transport = fakeTransport(() => ({ song_list: [fmRow(`fresh ${served++}`, `k${served}`)] }));
    const fm = createPersonalFm({ transport, device: () => DEVICE });
    await fm.start();
    const next = await fm.next(120);
    expect(next.current).not.toBeNull();
    const report = transport.bodies[1]!;
    expect(report.action).toBe("play");
    expect(report.playtime).toBe(120);
    // The same song never shows up twice across the whole session.
    const seen = [next.current, ...next.upcoming, ...next.history].filter(Boolean).map((track) => fmSongKey(track!));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("reports a dislike and steps back through history", async () => {
    let served = 0;
    const transport = fakeTransport(() => ({ song_list: [fmRow(`another ${served++}`, `j${served}`)] }));
    const fm = createPersonalFm({ transport, device: () => DEVICE });
    await fm.start();
    const first = fm.state().current;
    const after = await fm.dislike();
    expect(after.current?.id).not.toBe(first?.id);
    expect(transport.bodies[1]!.action).toBe("garbage");
    const back = fm.previous();
    expect(back.current?.id).toBe(first?.id);
  });

  it("throws the typed empty answer when the station has nothing left", async () => {
    const transport = fakeTransport(() => ({ song_list: [] }));
    const fm = createPersonalFm({ transport, device: () => DEVICE });
    await expect(fm.start()).rejects.toThrow(KugouError);
    await expect(fm.next()).rejects.toThrow(/nothing queued|returned no songs/);
  });
});
