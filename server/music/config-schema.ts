import { z } from "zod";

/**
 * `music` in config.json: what a bot may do with the player, the quality and mix
 * preferences, and the sources besides Kugou. The Kugou account token lives in
 * music-session.json, never here.
 */
export const musicConfigSchema = z.object({
  /** `read` unless set: a new bot sees the player but changes nothing until the person says so. */
  botAccess: z.enum(["off", "read", "control"]).optional(),
  defaultQuality: z.enum(["128k", "320k", "flac", "hires"]).optional(),
  /** The volume music drops to while speech holds the speaker, 0-100. */
  duckVolume: z.number().int().min(0).max(100).optional(),
  /** Cross-fade between tracks, in ms. Zero means a hard cut. */
  crossfadeMs: z.number().int().min(0).max(12_000).optional(),
  desktopLyrics: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  nowPlayingTheme: z.enum(["standard", "pendolo", "fume", "sonnet", "lumiere", "tempera"]).optional(),
  localFolders: z.array(z.string().trim().min(1).max(2_000)).max(64).optional(),
  jellyfin: z.object({
    baseUrl: z.string().trim().url().max(500),
    apiKey: z.string().trim().min(1).max(500),
    userId: z.string().trim().min(1).max(120).optional(),
  }).strict().optional(),
}).strict();

/** The shape a caller of `cfg.music` reads. */
export type MusicConfig = z.output<typeof musicConfigSchema>;
