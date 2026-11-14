import { createHash, randomUUID } from "node:crypto";
import {
  aggregateUsage,
  type UsageEntry,
  type UsageGroupBy,
} from "../shared/plugins/usage.ts";
import { appendUsage, csvCell, type UsageRow } from "./usage-ledger.ts";

function entryId(value: string): string {
  const id = createHash("sha256").update(value).digest("hex");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

export function meteredEntries(rows: readonly UsageRow[]): UsageEntry[] {
  const entries = new Map<string, UsageEntry>();
  for (const row of rows) {
    const entry: UsageEntry = {
      entryId: entryId(
        row.turnId ??
          `${row.at}|${row.botId}|${row.threadId}|${row.instanceId}`,
      ),
      ...(row.parent ? { parentId: entryId(row.parent.turnId) } : {}),
      at: row.at,
      botId: row.botId,
      kind: "model",
      unit: "tokens",
      quantity: row.input + row.output,
      model: row.model,
      cost:
        typeof row.costUsd !== "number" ||
        !Number.isFinite(row.costUsd) ||
        row.costUsd < 0
          ? { state: "unknown" }
          : {
              state: row.costSource === "estimated" ? "estimated" : "actual",
              amount: row.costUsd,
              currency: "USD",
              source:
                row.costSource === "estimated" ? "model-catalog" : "provider",
            },
      ...row.metering,
      provider: row.instanceId,
      threadId: row.threadId,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.accountId ? { accountId: row.accountId } : {}),
    };
    entries.set(entry.entryId, entry);
  }
  return [...entries.values()];
}

export function meteredSummary(rows: readonly UsageRow[], by: UsageGroupBy) {
  const entries = meteredEntries(rows);
  return { entries, groups: aggregateUsage(entries, by) };
}

export function meteredCsv(entries: readonly UsageEntry[]): string {
  const fields = [
    "entryId",
    "at",
    "botId",
    "taskId",
    "provider",
    "model",
    "pluginInstallationId",
    "accountId",
    "kind",
    "unit",
    "quantity",
  ] as const;
  return (
    [
      fields.join(",") + ",cost_state,amount,currency",
      ...entries
        .filter((entry) => !entry.rollup)
        .map((entry) =>
          [
            ...fields.map((key) => entry[key] ?? ""),
            entry.cost.state,
            entry.cost.amount ?? null,
            entry.cost.currency ?? "",
          ]
            .map(csvCell)
            .join(","),
        ),
    ].join("\n") + "\n"
  );
}

export function appendMeteredUsage(
  dataDir: string,
  input: {
    botId: string;
    threadId: string;
    provider: string;
    model?: string;
    taskId?: string;
    accountId?: string;
    kind: UsageEntry["kind"];
    unit: UsageEntry["unit"];
    quantity: number;
    pluginInstallationId?: string;
  },
): Promise<boolean> {
  return appendUsage(dataDir, {
    botId: input.botId,
    botName: input.botId,
    threadId: input.threadId,
    instanceId: input.provider,
    driverKind: input.provider,
    model: input.model ?? input.provider,
    input: 0,
    output: 0,
    costUsd: null,
    trigger: { kind: "owner" },
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    metering: {
      entryId: randomUUID(),
      kind: input.kind,
      unit: input.unit,
      quantity: input.quantity,
      cost: { state: "unknown" },
      ...(input.pluginInstallationId
        ? { pluginInstallationId: input.pluginInstallationId }
        : {}),
    },
  });
}
