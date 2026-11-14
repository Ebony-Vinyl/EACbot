// A CSV with a header row: `metric,value,at[,unit,endedAt,note]`. Column order does not matter and extra
// columns are ignored, so a spreadsheet a person keeps by hand imports without being reshaped first.
import { healthUnitOf } from "../../../shared/health.ts";
import type { HealthImporter, ImportResult, ImportProblem } from "./types.ts";

const REQUIRED = ["metric", "value", "at"] as const;

/** Quoted fields may hold the delimiter, a quote or a newline; unquoted fields are trimmed. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field.trim());
      field = "";
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (field.length || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.length > 0));
}

const normaliseHeader = (cell: string) => cell.toLowerCase().replace(/[\s-]+/g, "_");

export const csvImporter: HealthImporter = {
  format: "csv",

  detects(text) {
    const header = parseCsvRows(text)[0];
    if (!header) return false;
    const names = header.map(normaliseHeader);
    return REQUIRED.every((name) => names.includes(name));
  },

  parse(text, options): ImportResult {
    const rows = parseCsvRows(text);
    const header = (rows.shift() ?? []).map(normaliseHeader);
    const problems: ImportProblem[] = [];
    const samples: ImportResult["samples"] = [];
    const missing = REQUIRED.filter((name) => !header.includes(name));
    if (missing.length) {
      return { samples, problems: [{ row: 0, reason: `the header is missing ${missing.join(", ")}` }], read: 0 };
    }
    const at = (name: string) => header.indexOf(name);
    let read = 0;
    for (const [offset, cells] of rows.entries()) {
      read += 1;
      const rowNumber = offset + 2;
      const metric = cells[at("metric")] ?? "";
      const rawValue = cells[at("value")] ?? "";
      const rawAt = cells[at("at")] ?? "";
      if (!metric) {
        problems.push({ row: rowNumber, reason: "metric is empty" });
        continue;
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) {
        problems.push({ row: rowNumber, reason: `value "${rawValue.slice(0, 40)}" is not a number` });
        continue;
      }
      const parsedAt = new Date(rawAt);
      if (Number.isNaN(parsedAt.getTime())) {
        problems.push({ row: rowNumber, reason: `at "${rawAt.slice(0, 40)}" is not a time` });
        continue;
      }
      const endedIndex = at("endedat");
      const unitIndex = at("unit");
      const noteIndex = at("note");
      const endedAt = endedIndex >= 0 ? cells[endedIndex] : undefined;
      const note = noteIndex >= 0 ? cells[noteIndex] : undefined;
      const unit = unitIndex >= 0 && cells[unitIndex] ? cells[unitIndex]! : healthUnitOf(metric);
      samples.push({
        metric,
        value,
        unit,
        at: parsedAt.toISOString(),
        ...(endedAt ? { endedAt: new Date(endedAt).toISOString() } : {}),
        sourceId: options.sourceId,
        quality: "measured",
        ...(note ? { note: note.slice(0, 500) } : {}),
      });
    }
    return { samples, problems: problems.slice(0, 20), read };
  },
};
