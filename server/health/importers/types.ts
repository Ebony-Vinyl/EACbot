import type { HealthImportFormat, HealthSampleInput } from "../../../shared/health.ts";

/**
 * One importer per file shape. An importer reads text and returns rows or per-row
 * problems; it never writes, never validates against the store and never knows
 * about another importer, so a new format is one file plus one registry entry.
 */
export interface ImportProblem {
  row: number;
  reason: string;
}

export interface ImportResult {
  samples: HealthSampleInput[];
  problems: ImportProblem[];
  /** Rows the file held, including the ones refused. */
  read: number;
}

export interface HealthImporter {
  readonly format: HealthImportFormat;
  /** True when this text looks like this format, so a caller can offer to guess. */
  detects(text: string): boolean;
  parse(text: string, options: { sourceId: string; now: () => string }): ImportResult;
}
