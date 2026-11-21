// Music's side of audio focus. The coordinator (server/media/audio-focus.ts) owns
// the rule; this file only turns its leases into what the player and the views
// see, and reports the person's own pauses so a lease release never resumes music
// behind their back.
import { AudioFocusManager } from "../media/audio-focus.ts";
import type { AudioFocusKind, AudioFocusLease } from "../../shared/plugins/audio.ts";

/** How long a speech lease lives before the coordinator treats it as abandoned. */
export const SPEECH_LEASE_TTL_MS = 120_000;
/** How long an alert lease lives; an alert is shorter than a sentence. */
export const ALERT_LEASE_TTL_MS = 15_000;

export interface MusicFocusDeps {
  /** Pauses or resumes the music the player is actually running. */
  setDucked(ducked: boolean): void;
  /** True while the player is the one making sound, so a claim knows there is music to pause. */
  musicPlaying(): boolean;
  /** The volume a ducked track drops to, 0-100. */
  duckVolume?(): number;
  now?: () => number;
}

export interface MusicFocus {
  /** Takes a lease for speech or an alert; music is ducked while it is held. */
  claim(kind: AudioFocusKind, holderId: string, ttlMs?: number): AudioFocusLease;
  release(leaseId: string): void;
  /** The person pressed pause: a later release must not resume. */
  userPaused(): void;
  userResumed(): void;
  userVolumeChanged(): void;
  /** The player started a track on its own, so a later claim may duck it. */
  musicStarted(): void;
  musicStopped(): void;
  /** True while a lease holds the speaker. */
  ducked(): boolean;
  activeLease(): AudioFocusLease | null;
  dispose(): void;
}

/**
 * The manager pauses music logically and this wrapper tells the player, so the
 * two never disagree about whether the music is playing. A lease that expires
 * without a release restores music, which is what keeps a crashed speaker from
 * leaving the queue silent forever.
 */
export function createMusicFocus(deps: MusicFocusDeps): MusicFocus {
  const manager = new AudioFocusManager(deps.now ? { now: deps.now } : {});
  let duckedState = false;
  let sweeper: ReturnType<typeof setInterval> | null = null;

  const apply = (): void => {
    const snapshot = manager.snapshot();
    const nextDucked = snapshot.active !== null && !snapshot.musicPlaying;
    if (nextDucked !== duckedState) {
      duckedState = nextDucked;
      deps.setDucked(nextDucked);
    }
  };

  /**
   * A lease that expired with no release still has to restore music. The manager
   * only notices on the next claim or release, so this sweep notices for it.
   */
  const startSweep = (): void => {
    if (sweeper) return;
    sweeper = setInterval(() => {
      const snapshot = manager.snapshot();
      if (snapshot.active === null && snapshot.musicPlaying !== !snapshot.musicPausedByUser) {
        // The manager's own expiry path restores on the next claim; force it now
        // by claiming and immediately releasing a zero-cost probe is wrong, so
        // instead mirror its restore decision here.
        if (!snapshot.musicPausedByUser) manager.musicStarted();
        apply();
      }
    }, 5_000);
    sweeper.unref?.();
  };

  return {
    claim(kind, holderId, ttlMs) {
      const ttl = ttlMs ?? (kind === "alert" ? ALERT_LEASE_TTL_MS : SPEECH_LEASE_TTL_MS);
      // Tell the manager whether there is music to duck before it decides.
      if (deps.musicPlaying()) manager.musicStarted();
      const claim = manager.claim(kind, holderId, ttl);
      if (!claim.ok) throw Object.assign(new Error(claim.error), { code: claim.code });
      startSweep();
      apply();
      return claim.lease;
    },

    release(leaseId) {
      const result = manager.release(leaseId);
      if (!result.ok) return;
      // The manager decides whether music may resume; mirror that into the player.
      const snapshot = manager.snapshot();
      if (result.restoredMusic) {
        deps.setDucked(false);
        duckedState = false;
      } else if (snapshot.active === null) {
        duckedState = false;
        deps.setDucked(false);
      }
    },

    userPaused() {
      manager.userPause();
      apply();
    },

    userResumed() {
      manager.userResume();
      apply();
    },

    userVolumeChanged() {
      manager.userVolumeChanged();
    },

    musicStarted() {
      manager.musicStarted();
    },

    musicStopped() {
      manager.musicStopped();
    },

    ducked: () => duckedState,
    activeLease: () => manager.snapshot().active,

    dispose() {
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
    },
  };
}
