import { randomUUID } from "node:crypto";

import {
  FOCUS_PRIORITY,
  type AudioFocusKind,
  type AudioFocusLease,
  type FocusClaim,
  type FocusRelease,
} from "../../shared/plugins/audio.ts";

export interface AudioFocusOptions {
  now?: () => number;
  leaseId?: () => string;
}

const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 300_000;

/**
 * Audio focus for speech, alerts and music. Music paused by focus is resumed only when the last lease ends and the person
 * has not paused, resumed or changed the volume since it was paused.
 */
export class AudioFocusManager {
  private active: AudioFocusLease | null = null;
  private musicPlaying = false;
  private musicPausedByUser = false;
  private musicPausedForFocus = false;
  private pausedAtUserRevision = 0;
  private pausedAtVolumeRevision = 0;
  private userRevision = 0;
  private volumeRevision = 0;
  private readonly now: () => number;
  private readonly leaseId: () => string;

  constructor(options: AudioFocusOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.leaseId = options.leaseId ?? (() => randomUUID());
  }

  claim(kind: AudioFocusKind, holderId: string, ttlMs: number): FocusClaim {
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      return { ok: false, code: "INVALID_TTL", error: `a lease lasts between ${MIN_TTL_MS} and ${MAX_TTL_MS} ms` };
    }
    const at = this.now();
    const current = this.liveLease(at);
    if (!current && this.musicPausedForFocus) {
      // A lease that died without releasing (a crashed speaker) must not leave music paused forever.
      this.musicPausedForFocus = false;
      if (!this.musicPausedByUser
        && this.userRevision === this.pausedAtUserRevision
        && this.volumeRevision === this.pausedAtVolumeRevision) this.musicPlaying = true;
    }
    if (current && FOCUS_PRIORITY[current.kind] >= FOCUS_PRIORITY[kind]) {
      return { ok: false, code: "BUSY", error: `${current.kind} already holds audio focus` };
    }
    const pausedMusic = kind !== "music" && this.musicPlaying && !this.musicPausedByUser;
    if (pausedMusic) {
      this.musicPlaying = false;
      if (!this.musicPausedForFocus) {
        this.musicPausedForFocus = true;
        this.pausedAtUserRevision = this.userRevision;
        this.pausedAtVolumeRevision = this.volumeRevision;
      }
    }
    this.active = {
      leaseId: this.leaseId(),
      kind,
      holderId,
      acquiredAt: new Date(at).toISOString(),
      expiresAt: new Date(at + ttlMs).toISOString(),
      userRevision: this.userRevision,
      volumeRevision: this.volumeRevision,
    };
    return { ok: true, lease: { ...this.active }, pausedMusic };
  }

  release(leaseId: string): FocusRelease {
    if (!this.active || this.active.leaseId !== leaseId) {
      return { ok: false, code: "NOT_HOLDER", error: "this lease is no longer the active one" };
    }
    const expired = this.liveLease(this.now()) === null;
    this.active = null;
    const restore = !expired
      && this.musicPausedForFocus
      && !this.musicPausedByUser
      && this.userRevision === this.pausedAtUserRevision
      && this.volumeRevision === this.pausedAtVolumeRevision;
    this.musicPausedForFocus = false;
    if (restore) this.musicPlaying = true;
    return { ok: true, restoredMusic: restore };
  }

  /** The person pressed pause: later lease releases must not resume music behind their back. */
  userPause(): void {
    this.musicPlaying = false;
    this.musicPausedByUser = true;
    this.musicPausedForFocus = false;
    this.userRevision += 1;
  }

  userResume(): void {
    this.musicPlaying = true;
    this.musicPausedByUser = false;
    this.musicPausedForFocus = false;
    this.userRevision += 1;
  }

  userVolumeChanged(): void {
    this.volumeRevision += 1;
  }

  /** The player started a track on its own (or after a user play), so a later focus claim may pause it. */
  musicStarted(): void {
    this.musicPlaying = true;
    this.musicPausedByUser = false;
  }

  musicStopped(): void {
    this.musicPlaying = false;
  }

  snapshot(): {
    active: AudioFocusLease | null;
    musicPlaying: boolean;
    musicPausedByUser: boolean;
    userRevision: number;
    volumeRevision: number;
  } {
    return {
      active: this.liveLease(this.now()),
      musicPlaying: this.musicPlaying,
      musicPausedByUser: this.musicPausedByUser,
      userRevision: this.userRevision,
      volumeRevision: this.volumeRevision,
    };
  }

  private liveLease(at: number): AudioFocusLease | null {
    if (!this.active) return null;
    return Date.parse(this.active.expiresAt) > at ? this.active : null;
  }
}
