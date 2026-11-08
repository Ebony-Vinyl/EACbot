import { z } from "zod";

export const AUDIO_FORMATS = ["pcm16", "mp3", "opus", "wav"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export const audioChunkSchema = z.object({
  streamId: z.string().min(1).max(120),
  /** Bumped whenever the producer starts a new utterance; frames from an older generation are stale. */
  generation: z.number().int().min(0),
  sequence: z.number().int().min(0),
  format: z.enum(AUDIO_FORMATS),
  sampleRate: z.number().int().min(8_000).max(192_000),
  channels: z.number().int().min(1).max(2),
  /** Base64 of the encoded frame; the host never logs this field. */
  data: z.string().max(4 * 1024 * 1024),
  final: z.boolean().optional(),
}).strict();

export type AudioChunk = z.infer<typeof audioChunkSchema>;

export const AUDIO_FOCUS_KINDS = ["alert", "speech", "music"] as const;
export type AudioFocusKind = (typeof AUDIO_FOCUS_KINDS)[number];

export const FOCUS_PRIORITY: Readonly<Record<AudioFocusKind, number>> = { alert: 3, speech: 2, music: 1 };

export interface AudioFocusLease {
  leaseId: string;
  kind: AudioFocusKind;
  holderId: string;
  acquiredAt: string;
  expiresAt: string;
  /** The user revision this lease saw; a later manual pause outranks the lease's restore request. */
  userRevision: number;
  volumeRevision: number;
}

export type FocusRefusalCode = "BUSY" | "INVALID_TTL";

export type FocusClaim =
  | { ok: true; lease: AudioFocusLease; pausedMusic: boolean }
  | { ok: false; code: FocusRefusalCode; error: string };

export type FocusRelease =
  | { ok: true; restoredMusic: boolean }
  | { ok: false; code: "NOT_HOLDER"; error: string };
