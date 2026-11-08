import type { AudioChunk } from "../../shared/plugins/audio.ts";

export type StreamVerdict =
  | { action: "accepted"; expected: number }
  | { action: "duplicate" }
  | { action: "stale" }
  | { action: "gap"; expected: number }
  | { action: "format-mismatch"; expectedFormat: string };

interface StreamState {
  generation: number;
  next: number;
  format: string;
  sampleRate: number;
  channels: number;
}

const MAX_STREAMS = 32;

/** Per-stream sequence and generation checks; a reconnect or a newer utterance starts a new sequence. */
export class AudioStreamTracker {
  private streams = new Map<string, StreamState>();

  accept(chunk: AudioChunk): StreamVerdict {
    const state = this.streams.get(chunk.streamId);
    if (!state) {
      this.remember(chunk.streamId, { generation: chunk.generation, next: 1, format: chunk.format, sampleRate: chunk.sampleRate, channels: chunk.channels });
      return chunk.sequence === 0 ? { action: "accepted", expected: 1 } : { action: "gap", expected: 0 };
    }
    if (chunk.generation < state.generation) return { action: "stale" };
    if (chunk.generation > state.generation) {
      this.remember(chunk.streamId, { generation: chunk.generation, next: 1, format: chunk.format, sampleRate: chunk.sampleRate, channels: chunk.channels });
      return chunk.sequence === 0 ? { action: "accepted", expected: 1 } : { action: "gap", expected: 0 };
    }
    if (chunk.format !== state.format || chunk.sampleRate !== state.sampleRate || chunk.channels !== state.channels) {
      return { action: "format-mismatch", expectedFormat: `${state.format}/${state.sampleRate}/${state.channels}` };
    }
    if (chunk.sequence < state.next) return { action: "duplicate" };
    if (chunk.sequence > state.next) return { action: "gap", expected: state.next };
    state.next += 1;
    return { action: "accepted", expected: state.next };
  }

  forget(streamId: string): void {
    this.streams.delete(streamId);
  }

  private remember(streamId: string, state: StreamState): void {
    // Re-inserting moves the stream to the newest position, so eviction takes the least recently used one.
    this.streams.delete(streamId);
    if (this.streams.size >= MAX_STREAMS) {
      const oldest = this.streams.keys().next().value;
      if (oldest !== undefined) this.streams.delete(oldest);
    }
    this.streams.set(streamId, state);
  }
}
