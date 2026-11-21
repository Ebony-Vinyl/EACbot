import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

/**
 * The music wiring end to end: a real server, the real routes, the real player.
 *
 * Kugou itself is not reached here. What this proves is the part a unit test
 * cannot: that server/index.ts mounted the domain, that the routes answer under
 * the owner's authority, that the player's revision and receipt rules hold over
 * HTTP, and that a refused request is refused rather than silently accepted.
 *
 * It does not prove that a browser decodes audio, or that Kugou serves a URL.
 */
it("serves the music surface from a real server", async () => {
  const fixture = await launchVerificationServer({});
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
  };

  /** The JSON a route answered, or a failure that names the route rather than a null dereference. */
  const bodyOf = (answer: { body: Record<string, any> | null }, what: string): Record<string, any> => {
    if (!answer.body) throw new Error(`${what} answered no JSON`);
    return answer.body;
  };

  try {
    // A local track is the one source that needs no account and no network, so it
    // is what this fixture plays.
    const folder = join(fixture.info.dataDir, "music");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folder, { recursive: true });
    // A WAV is readable without a tag library: the scanner falls back to the file name.
    const wav = Buffer.alloc(44 + 1_000 * 2);
    wav.write("RIFF", 0, "ascii");
    wav.writeUInt32LE(36 + 1_000 * 2, 4);
    wav.write("WAVE", 8, "ascii");
    wav.write("fmt ", 12, "ascii");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44_100, 24);
    wav.writeUInt32LE(88_200, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "ascii");
    wav.writeUInt32LE(1_000 * 2, 40);
    writeFileSync(join(folder, "Local Song.wav"), wav);

    // Point the library at that folder, then scan.
    const config = await api("PUT", "/api/config", { music: { localFolders: [folder] } });
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    const scanned = await api("POST", "/api/music/library/scan");
    expect(scanned.status).toBe(200);

    const library = await api("GET", "/api/music/library");
    expect(library.status).toBe(200);
    const tracks = bodyOf(library, "the library").tracks as Array<{ id: string; title: string }>;
    expect(tracks.length).toBeGreaterThan(0);
    const trackId = tracks[0]!.id;
    expect(trackId.startsWith("local:")).toBe(true);

    // The snapshot is the whole truth at one revision, and nothing is playing yet.
    const snapshot = await api("GET", "/api/music");
    expect(snapshot.status).toBe(200);
    const playback = bodyOf(snapshot, "the snapshot").playback as { revision: number; state: string; playbackConfirmed: boolean };
    expect(playback.state).toBe("idle");
    expect(playback.playbackConfirmed).toBe(false);
    const firstRevision = playback.revision;

    // Queue the local track.
    const queued = await api("POST", "/api/music/queue", { action: "add", trackIds: [trackId] });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    const afterQueue = bodyOf(queued, "the queue").playback as { revision: number; current: { track: { id: string } } | null; state: string };
    expect(afterQueue.current?.track.id).toBe(trackId);
    expect(afterQueue.revision).toBeGreaterThan(firstRevision);

    // A control built from the old revision is refused with a conflict, not applied.
    const stale = await api("POST", "/api/music/control", { action: "pause", expectedRevision: firstRevision });
    expect(stale.status).toBe(409);
    expect((bodyOf(stale, "the stale control").error as { code: string }).code).toBe("stale_revision");

    // A request to play is not a play: it becomes buffering and stays unconfirmed.
    const play = await api("POST", "/api/music/control", { action: "play", expectedRevision: afterQueue.revision });
    expect(play.status).toBe(200);
    const requested = bodyOf(play, "the play request").playback as { state: string; playbackConfirmed: boolean; revision: number };
    expect(requested.state).toBe("buffering");
    expect(requested.playbackConfirmed).toBe(false);

    // A client's receipt is what confirms it.
    const receipt = await api("POST", "/api/music/receipts", { state: "playing", revision: requested.revision, positionSeconds: 1 });
    expect(receipt.status).toBe(200);
    const confirmed = bodyOf(receipt, "the receipt").playback as { playbackConfirmed: boolean; state: string };
    expect(confirmed.state).toBe("playing");
    expect(confirmed.playbackConfirmed).toBe(true);

    // A failed receipt says why, removes the failed track and, with nothing left queued, stops.
    const failed = await api("POST", "/api/music/receipts", { state: "failed", revision: (bodyOf(receipt, "the receipt").playback as { revision: number }).revision, code: "decode", message: "the browser cannot decode this stream" });
    expect(failed.status).toBe(200);
    const stopped = bodyOf(failed, "the failed receipt").playback as { state: string; failure: { code: string }; current: { track: { id: string } } | null };
    expect(stopped.state).toBe("failed");
    expect(stopped.failure.code).toBe("decode");
    expect(stopped.current).toBeNull();

    // The stream handle for a local file answers with its bytes and a range.
    const handles = await api("POST", "/api/music/stream", { trackIds: [trackId], quality: "320k" });
    expect(handles.status).toBe(200);
    const handle = (bodyOf(handles, "the stream handles").handles as Array<{ url?: string; error?: unknown }>)[0];
    expect(handle?.url, JSON.stringify(handles.body)).toBeTruthy();
    const ranged = await fetch(url + handle!.url!, { headers: { range: "bytes=0-3" }, signal: AbortSignal.timeout(20_000) });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("RIFF");

    // The EQ and theme persist through the same surface the settings page uses.
    const eq = await api("PUT", "/api/music/eq", { gains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], preset: "custom", enabled: true });
    expect(eq.status).toBe(200);
    const readEq = await api("GET", "/api/music/eq");
    expect((bodyOf(readEq, "the EQ").eq as { gains: number[] }).gains[0]).toBe(1);

    const theme = await api("PUT", "/api/music/theme", { theme: "fume" });
    expect(theme.status).toBe(200);
    expect(bodyOf(await api("GET", "/api/music/theme"), "the theme").theme).toBe("fume");

    // Search goes out to Kugou, so the answer depends on the network and the region.
    // What must hold either way is the envelope: a hit list, or a typed refusal that
    // says which of the known reasons it was.
    const search = await api("GET", "/api/music/search?q=test");
    if (search.status === 200) {
      expect(Array.isArray(bodyOf(search, "the search").tracks)).toBe(true);
    } else {
      const code = (bodyOf(search, "the search").error as { code: string }).code;
      expect(["not_logged_in", "expired_session", "risk_control", "unreachable", "source_unavailable", "not_found"]).toContain(code);
    }

    // An unknown endpoint is a 404 with the same envelope.
    const missing = await api("GET", "/api/music/nonsense");
    expect(missing.status).toBe(404);
    expect((bodyOf(missing, "the missing endpoint").error as { code: string }).code).toBe("not_found");
  } finally {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
  }
}, 180_000);
