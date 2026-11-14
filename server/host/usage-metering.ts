import type { AppConfig } from "../config.ts";
import type { PriceList } from "../prices.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import type { UsageRow } from "../usage-ledger.ts";
import { appendUsage } from "../usage-ledger.ts";
import { appendMeteredUsage } from "../usage-metering.ts";
import { ledgerCost } from "../model-prices.ts";
import {
  noteSpend,
  spendState,
  takeSpendAlert,
  type SpendAlert,
  type SpendState,
} from "../spend.ts";

export function createUsageMetering(deps: {
  dataDir: string;
  config(): AppConfig;
  store(): Store;
  prices(): PriceList | null;
  attribute(row: UsageRow): UsageRow;
  trace(threadId: string): Partial<UsageRow>;
  taskForThread(threadId: string): string | undefined;
  readable(auth: RequestAuth, threadId: string): boolean;
  notify(
    row: Pick<UsageRow, "botId" | "botName">,
    threadId: string,
    state: SpendState,
    alert: SpendAlert,
  ): void;
}) {
  return {
    book(
      row: Omit<UsageRow, "at" | "costSource">,
      tokensReported = true,
      notificationThreadId = row.threadId,
    ): void {
      const cost =
        tokensReported || row.costUsd !== null
          ? ledgerCost(row, deps.prices())
          : { costUsd: null };
      const taskId =
        deps.taskForThread(row.threadId) ??
        (row.parent ? deps.taskForThread(row.parent.threadId) : undefined);
      const accountId = deps.store().taskByThread(row.botId, row.threadId)
        ?.platformContext?.accountId;
      const booked = deps.attribute({
        ...row,
        ...(taskId ? { taskId } : {}),
        ...(accountId ? { accountId } : {}),
        ...cost,
        ...deps.trace(row.threadId),
        at: new Date().toISOString(),
      });
      noteSpend(deps.dataDir, booked, appendUsage(deps.dataDir, booked));
      const state = spendState(deps.config(), deps.dataDir);
      const alert = takeSpendAlert(deps.dataDir, state);
      if (alert && state) deps.notify(row, notificationThreadId, state, alert);
    },
    plugin({
      botId,
      threadId,
      installationId,
      accountId,
    }: {
      botId: string;
      threadId?: string;
      installationId: string;
      accountId?: string;
    }): void {
      const thread = threadId ?? deps.store().bot(botId)?.threadId;
      if (thread)
        void appendMeteredUsage(deps.dataDir, {
          botId,
          threadId: thread,
          kind: "plugin",
          unit: "requests",
          quantity: 1,
          provider: "plugin",
          pluginInstallationId: installationId,
          accountId,
          taskId: deps.taskForThread(thread),
        });
    },
    image(threadId: string, image: { provider: string; model: string }): void {
      const bot = deps.store().botByThread(threadId);
      if (bot)
        void appendMeteredUsage(deps.dataDir, {
          botId: bot.id,
          threadId,
          kind: "image",
          unit: "images",
          quantity: 1,
          provider: image.provider,
          model: image.model,
          taskId: deps.taskForThread(threadId),
        });
    },
    voice(
      auth: RequestAuth,
      input: {
        botId?: string;
        kind: "tts" | "stt";
        provider: string;
        unit: "characters" | "seconds" | "requests";
        quantity: number;
      },
    ): void {
      const bot = input.botId
        ? deps.store().bot(input.botId)
        : deps
            .store()
            .bots.find(
              (entry) => !entry.hidden && deps.readable(auth, entry.threadId),
            );
      if (bot && deps.readable(auth, bot.threadId))
        void appendMeteredUsage(deps.dataDir, {
          ...input,
          botId: bot.id,
          threadId: bot.threadId,
        });
    },
  };
}
