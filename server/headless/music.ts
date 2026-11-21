// `eacbot music`: the player from a terminal. These verbs drive the same /api/music
// routes the page uses, so a script, a CI step or the bot's own tooling changes the
// one queue rather than starting a second one.
import { EXIT, flag, usageError } from "./args.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

type Rec = Record<string, any>;

/** One track as the terminal shows it. */
function trackLine(track: Rec, index?: number): string {
  const artists = Array.isArray(track.artists) && track.artists.length ? ` — ${track.artists.join(", ")}` : "";
  const prefix = typeof index === "number" ? `${String(index + 1).padStart(2, " ")}. ` : "";
  const vip = track.vip ? " [VIP]" : "";
  const seconds = Number(track.durationSeconds ?? 0);
  const length = seconds > 0 ? ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})` : "";
  return `${prefix}${track.title}${artists}${length}${vip}`;
}

export async function music(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  const action = ctx.positionals[0] ?? "status";
  const rest = ctx.positionals.slice(1);

  const read = async (path: string): Promise<Rec | null> => client.json<Rec>(path).catch(() => null);
  const post = (path: string, body: Rec) => client.json<Rec>(path, { method: "POST", body: JSON.stringify(body) });

  const nowPlaying = async (): Promise<VerbOutcome> => {
    const snapshot = await read("/api/music");
    if (!snapshot) return { result: { ok: false, reason: "the music service did not answer" }, exitCode: EXIT.unreachable, human: ["The music service did not answer."] };
    const playback = snapshot.playback ?? {};
    const current = playback.current;
    const account = snapshot.account ?? {};
    const lines = current
      ? [
        `${playback.state === "playing" ? "▶" : "⏸"} ${trackLine(current.track)}`,
        `   ${playback.playbackConfirmed ? "confirmed by the player" : "not confirmed yet: nothing is sounding"}` +
          `, ${playback.queue?.length ?? 0} in the queue, volume ${playback.volume}, ${playback.quality}${playback.ducked ? ", turned down for speech" : ""}`,
      ]
      : ["Nothing is queued."];
    if (!account.loggedIn) lines.push("Not signed in to Kugou: only local files and your own folders can play.");
    return { result: { ok: true, playback, account, adapters: snapshot.adapters ?? [] }, exitCode: EXIT.done, human: lines };
  };

  if (action === "status" || action === "now") return nowPlaying();

  if (action === "search") {
    const keyword = rest.join(" ").trim();
    if (!keyword) throw usageError('music search needs words, e.g. eacbot music search 晴天');
    const answer = await read(`/api/music/search?q=${encodeURIComponent(keyword)}`);
    if (!answer) return { result: { ok: false }, exitCode: EXIT.unreachable, human: ["The music service did not answer."] };
    const tracks: Rec[] = Array.isArray(answer.tracks) ? answer.tracks : [];
    if (!tracks.length) return { result: answer, exitCode: EXIT.done, human: [`No songs for "${keyword}".`] };
    return {
      result: answer,
      exitCode: EXIT.done,
      human: [`${tracks.length} songs for "${keyword}":`, ...tracks.map((track, index) => trackLine(track, index)), "", "Play one with: eacbot music play <id> (the id is under the song: use --json)"],
    };
  }

  if (action === "play") {
    // `play <id>` queues one track; `play <words>` searches and takes the first hit.
    const first = rest[0];
    if (!first) throw usageError('music play needs a track id or words, e.g. eacbot music play 晴天');
    let trackId = first.startsWith("kugou:") || first.startsWith("local:") || first.startsWith("jellyfin:") ? first : "";
    let picked: Rec | null = null;
    if (!trackId) {
      const keyword = rest.join(" ").trim();
      const answer = await read(`/api/music/search?q=${encodeURIComponent(keyword)}&pageSize=5`);
      const tracks: Rec[] = Array.isArray(answer?.tracks) ? answer.tracks : [];
      if (!tracks.length) return { result: { ok: false, keyword }, exitCode: EXIT.done, human: [`No songs for "${keyword}".`] };
      picked = tracks[0]!;
      trackId = String(picked.id);
    }
    const queued = await post("/api/music/queue", { action: "add", trackIds: [trackId], position: "end" });
    await post("/api/music/control", { action: "play" });
    const current = queued?.playback?.current;
    return {
      result: { ok: true, queued: current?.track ?? picked },
      exitCode: EXIT.done,
      human: [
        `Queued: ${current ? trackLine(current.track) : trackId}`,
        "Requested playback. It counts as playing only once the player reports back; `eacbot music status` says which.",
      ],
    };
  }

  if (action === "pause" || action === "resume" || action === "next" || action === "previous" || action === "prev") {
    const command = action === "prev" ? "prev" : action === "previous" ? "prev" : action;
    const answer = await post("/api/music/control", { action: command });
    if (!answer) return { result: { ok: false }, exitCode: EXIT.unreachable, human: ["The music service did not answer."] };
    const playback = answer.playback ?? {};
    const current = playback.current;
    return {
      result: answer,
      exitCode: EXIT.done,
      human: [current ? `${playback.state}: ${trackLine(current.track)}` : `Nothing is queued (${playback.state}).`],
    };
  }

  if (action === "volume") {
    const level = Number(rest[0]);
    if (!Number.isFinite(level)) throw usageError("music volume needs a number 0-100");
    const answer = await post("/api/music/control", { action: "volume", volume: level });
    return { result: answer, exitCode: EXIT.done, human: [`Volume ${answer?.playback?.volume ?? level}.`] };
  }

  if (action === "queue") {
    const playback = (await read("/api/music/playback"))?.playback ?? {};
    const queue: Rec[] = Array.isArray(playback.queue) ? playback.queue : [];
    if (!queue.length) return { result: { queue: [], revision: playback.revision }, exitCode: EXIT.done, human: ["The queue is empty."] };
    return {
      result: { queue, revision: playback.revision },
      exitCode: EXIT.done,
      human: [
        ...queue.map((item, index) => `${index === playback.currentIndex ? "▶" : " "} ${trackLine(item.track, index)}`),
        "",
        "Remove one with: eacbot music queue-remove <queueItemId> (--json shows the ids)",
      ],
    };
  }

  if (action === "queue-remove") {
    const queueItemId = rest[0];
    if (!queueItemId) throw usageError("music queue-remove needs a queueItemId from `music queue --json`");
    const answer = await post("/api/music/queue", { action: "remove", queueItemId });
    return { result: answer, exitCode: EXIT.done, human: [`Removed. ${answer?.playback?.queue?.length ?? 0} left in the queue.`] };
  }

  if (action === "clear") {
    const answer = await post("/api/music/queue", { action: "clear" });
    return { result: answer, exitCode: EXIT.done, human: ["The queue is empty."] };
  }

  if (action === "lyrics") {
    const trackId = rest[0] ?? (await read("/api/music/playback"))?.playback?.current?.track?.id;
    if (!trackId) return { result: { ok: false }, exitCode: EXIT.done, human: ["Nothing is playing and no track id was given."] };
    const lyrics = await read(`/api/music/lyrics?trackId=${encodeURIComponent(trackId)}`);
    const lines: Rec[] = Array.isArray(lyrics?.lines) ? lyrics.lines : [];
    if (!lines.length) return { result: lyrics, exitCode: EXIT.done, human: [lyrics?.unavailableReason ?? "No lyrics for this track."] };
    return {
      result: lyrics,
      exitCode: EXIT.done,
      human: lines.map((line) => {
        const at = Number(line.atMs ?? 0);
        const stamp = `[${String(Math.floor(at / 60_000)).padStart(2, "0")}:${String(Math.floor((at % 60_000) / 1_000)).padStart(2, "0")}]`;
        return `${stamp} ${line.text}`;
      }),
    };
  }

  if (action === "login") {
    const answer = await read("/api/music/account");
    const account = answer?.account ?? {};
    return {
      result: answer,
      exitCode: EXIT.done,
      human: [account.loggedIn
        ? `Signed in as ${account.nickname ?? account.userId}${account.vip ? ` (${account.vipLabel ?? "VIP"})` : ""}.`
        : "Not signed in. Scan the QR code on the music page, or use Settings → Music."],
    };
  }

  if (action === "identify") {
    const seconds = Number(flag(ctx.flags, "seconds") ?? rest[0] ?? 6);
    return {
      result: { ok: false, reason: "a recording is needed" },
      exitCode: EXIT.done,
      human: [`Identification needs ${Number.isFinite(seconds) ? seconds : 6} seconds of audio, which a terminal cannot record. Use Listen on the music page, or POST the PCM to /api/music/identify.`],
    };
  }

  throw usageError(`music ${action}: use status, search, play, pause, resume, next, previous, volume, queue, queue-remove, clear, lyrics, login or identify`);
}
