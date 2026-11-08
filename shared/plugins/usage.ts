import { z } from "zod";

export const USAGE_KINDS = ["model", "tts", "stt", "video", "image", "plugin"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_UNITS = ["tokens", "characters", "seconds", "images", "requests"] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export const usageCostSchema = z.object({
  state: z.enum(["actual", "estimated", "free", "unknown"]),
  amount: z.number().finite().min(0).optional(),
  currency: z.enum(["USD", "CNY"]).optional(),
}).strict().superRefine((cost, context) => {
  if ((cost.state === "actual" || cost.state === "estimated") && (cost.amount === undefined || cost.currency === undefined)) {
    context.addIssue({ code: "custom", message: `${cost.state} cost needs an amount and a currency` });
  }
});

export type UsageCost = z.infer<typeof usageCostSchema>;

export const usageEntrySchema = z.object({
  entryId: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
  kind: z.enum(USAGE_KINDS),
  botId: z.string().min(1).max(120),
  pluginInstallationId: z.string().max(120).optional(),
  model: z.string().max(200).optional(),
  unit: z.enum(USAGE_UNITS),
  quantity: z.number().finite().min(0),
  cost: usageCostSchema,
  /** Links a delegated job to the turn that caused it; it never changes the charged quantity. */
  parentId: z.string().uuid().optional(),
  rootId: z.string().uuid().optional(),
  /** A parent row that repeats its children's totals; aggregation skips it so the same cost is not counted twice. */
  rollup: z.boolean().optional(),
}).strict();

export type UsageEntry = z.infer<typeof usageEntrySchema>;

export type UsageGroupBy = "bot" | "kind" | "plugin" | "model" | "day";

export interface UsageAggregate {
  key: string;
  entries: number;
  quantities: Partial<Record<UsageUnit, number>>;
  actual: Partial<Record<"USD" | "CNY", number>>;
  estimated: Partial<Record<"USD" | "CNY", number>>;
  free: number;
  unknown: number;
}

function groupKey(entry: UsageEntry, by: UsageGroupBy): string {
  switch (by) {
    case "bot": return entry.botId;
    case "kind": return entry.kind;
    case "plugin": return entry.pluginInstallationId ?? "none";
    case "model": return entry.model ?? "none";
    case "day": return entry.at.slice(0, 10);
  }
}

/** Rollup rows are skipped; unknown cost is counted, never added as zero. */
export function aggregateUsage(entries: readonly UsageEntry[], by: UsageGroupBy): UsageAggregate[] {
  const groups = new Map<string, UsageAggregate>();
  for (const entry of entries) {
    if (entry.rollup) continue;
    const key = groupKey(entry, by);
    let group = groups.get(key);
    if (!group) {
      group = { key, entries: 0, quantities: {}, actual: {}, estimated: {}, free: 0, unknown: 0 };
      groups.set(key, group);
    }
    group.entries += 1;
    group.quantities[entry.unit] = (group.quantities[entry.unit] ?? 0) + entry.quantity;
    if (entry.cost.state === "free") group.free += 1;
    else if (entry.cost.state === "unknown") group.unknown += 1;
    else if (entry.cost.amount !== undefined && entry.cost.currency) {
      const bucket = entry.cost.state === "actual" ? group.actual : group.estimated;
      bucket[entry.cost.currency] = (bucket[entry.cost.currency] ?? 0) + entry.cost.amount;
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function totalUsage(entries: readonly UsageEntry[]): UsageAggregate {
  const [total] = aggregateUsage(entries.map((entry) => ({ ...entry, botId: "total" })), "bot");
  return total ?? { key: "total", entries: 0, quantities: {}, actual: {}, estimated: {}, free: 0, unknown: 0 };
}
