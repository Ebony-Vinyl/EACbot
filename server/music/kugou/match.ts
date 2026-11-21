// Listen-and-identify: the client records a few seconds of microphone PCM, this
// server signs it with the official Android credentials and forwards it, and the
// answer comes back as ordinary tracks the player can queue.
import type { MusicTrack } from "../../../shared/music.ts";
import { officialSignature, OFFICIAL_APP_ID, OFFICIAL_CLIENT_VER } from "./signer.ts";
import { KugouError, type KugouTransport } from "./transport.ts";
import { trackFromRow } from "./catalog.ts";

/** The most PCM one identification may carry: 12 seconds at 44.1 kHz mono 16-bit. */
export const MAX_IDENTIFY_BYTES = 44_100 * 2 * 12;

export interface KugouMatchOptions {
  transport: KugouTransport;
  device(): { dfid: string; mid: string; uuid: string; userId: string };
  now?: () => number;
}

export interface KugouMatchClient {
  /** Identifies PCM audio. `pcm` is 16-bit little-endian mono at `sampleRate`. */
  identify(pcm: Uint8Array, input?: { sampleRate?: number }): Promise<MusicTrack[]>;
}

interface MatchPayload {
  data?: unknown[];
  candidates?: unknown[];
  status?: number;
  error?: string;
  result?: unknown[];
}

export function createKugouMatchClient(options: KugouMatchOptions): KugouMatchClient {
  const { transport, device } = options;
  const now = options.now ?? (() => Date.now());

  return {
    async identify(pcm, input) {
      if (!pcm.byteLength) throw new KugouError("invalid_input", "no audio was recorded", false);
      if (pcm.byteLength > MAX_IDENTIFY_BYTES) {
        throw new KugouError("invalid_input", `record at most ${Math.floor(MAX_IDENTIFY_BYTES / 2 / (input?.sampleRate ?? 44_100))} seconds of audio`, false);
      }
      const current = device();
      const clientTimeMs = now();
      const params: Record<string, string> = {
        appid: OFFICIAL_APP_ID,
        clientver: OFFICIAL_CLIENT_VER,
        dfid: current.dfid || "-",
        mid: current.mid,
        uuid: current.uuid,
        clienttime: String(Math.floor(clientTimeMs / 1_000)),
        fpid: String(clientTimeMs),
        area_code: "1",
        include_unpublish: "1",
        useid: current.userId || "0",
        multi_result: "1",
      };
      params.signature = officialSignature(params);
      const payload = await transport.request<MatchPayload>({
        url: "https://fingerprint.service.kugou.com/v1/music_trackid_mulit",
        method: "POST",
        params,
        signature: "none",
        body: Buffer.from(pcm).toString("binary"),
        contentType: "application/octet-stream",
        headers: { "user-agent": "KuGou/11490 (Android)" },
        timeoutMs: 20_000,
      });
      const rows = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.candidates) ? payload.candidates
        : Array.isArray(payload?.result) ? payload.result
        : [];
      if (!rows.length) return [];
      const tracks: MusicTrack[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        // A match nests the song under `song` or `audio` on some builds.
        const inner = (record.song ?? record.audio ?? record) as Record<string, unknown>;
        const track = trackFromRow({ ...inner, ...record });
        if (!track || seen.has(track.id)) continue;
        seen.add(track.id);
        tracks.push(track);
      }
      return tracks;
    },
  };
}
