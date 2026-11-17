import type { HealthSampleInput } from "../../../shared/health.ts";

/**
 * One cloud health service. An adapter owns one vendor's OAuth vocabulary and
 * one vendor's payload shape; it never writes to the store, never decides who
 * may read, and never knows about another adapter. A sync hands back rows and
 * the cursor to resume from, so a second sync fetches only what is new.
 */
export interface HealthSyncWindow {
  /** Rows at or after this instant, so an overlapping window re-reads its own tail rather than missing a gap. */
  from: string;
  to: string;
}

export interface HealthSyncResult {
  samples: HealthSampleInput[];
  /** Where the next sync starts. Absent means "start from the newest row this sync saw". */
  cursor?: string;
  /** Rows the provider held but this build cannot name a metric for, so the caller can say so. */
  skipped: number;
  /** Per-row refusals: a value the provider sent that the domain will not store. */
  problems: Array<{ row: number; reason: string }>;
}

export interface HealthCloudAdapter {
  readonly adapterId: string;
  readonly label: string;
  /** The `sourceId` every sample this adapter produces carries. */
  readonly sourceId: string;
  /** Reads rows between two instants. Throws `HealthCloudError`; never returns a half-written batch. */
  fetch(window: HealthSyncWindow, cursor: string | undefined): Promise<HealthSyncResult>;
}

export type HealthCloudErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "bad_response"
  | "not_supported";

export class HealthCloudError extends Error {
  readonly code: HealthCloudErrorCode;
  /** The provider's own words, already truncated, for the person to read. */
  readonly detail?: string;
  constructor(code: HealthCloudErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "HealthCloudError";
    this.code = code;
    this.detail = detail;
  }
}

/** Every adapter maps a vendor's own measurement names onto the domain's vocabulary through this. */
export function metricFrom(map: Readonly<Record<string, string>>, key: string): string | null {
  return Object.hasOwn(map, key) ? map[key]! : null;
}
