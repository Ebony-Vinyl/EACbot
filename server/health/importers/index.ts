import type { HealthImportFormat } from "../../../shared/health.ts";
import { appleHealthImporter } from "./apple-health.ts";
import { csvImporter } from "./csv.ts";
import { jsonImporter } from "./json.ts";
import type { HealthImporter } from "./types.ts";

export type { HealthImporter, ImportProblem, ImportResult } from "./types.ts";

/** Every format this build can read. Adding one is a new file and one line here. */
export const HEALTH_IMPORTERS: ReadonlyArray<HealthImporter> = [csvImporter, jsonImporter, appleHealthImporter];

export function importerFor(format: HealthImportFormat): HealthImporter | null {
  return HEALTH_IMPORTERS.find((importer) => importer.format === format) ?? null;
}

/** The format this text looks like, so an upload can name it instead of asking. */
export function detectFormat(text: string): HealthImportFormat | null {
  return HEALTH_IMPORTERS.find((importer) => importer.detects(text))?.format ?? null;
}
