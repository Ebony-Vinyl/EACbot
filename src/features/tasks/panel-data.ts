import { api } from "@/state/api";
import type { UsageEntry } from "../../../shared/plugins/usage";
import { readTaskBoards } from "./api";

export async function readTaskPanelData(
  source: "tasks" | "usage",
  botId?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (source === "tasks")
    return (await readTaskBoards(signal))
      .filter(
        (task) => !task.archivedAt && (!botId || task.assigneeBotId === botId),
      )
      .slice(0, 100)
      .map(
        ({
          taskId,
          title,
          column,
          assigneeBotId,
          source,
          priority,
          nextRunAt,
        }) => ({
          taskId,
          title,
          column,
          botId: assigneeBotId,
          source,
          priority,
          nextRunAt,
        }),
      );
  const query = new URLSearchParams(botId ? { botId } : {});
  const result = await api<{ entries: UsageEntry[] }>(
    `/api/usage/metering?${query}`,
    { signal, background: true },
  );
  return result.entries.map(
    ({ botId, kind, unit, quantity, cost, taskId }) => ({
      botId,
      kind,
      unit,
      quantity,
      cost,
      taskId,
    }),
  );
}
