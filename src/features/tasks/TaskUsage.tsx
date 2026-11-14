import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type {
  UsageAggregate,
  UsageEntry,
  UsageGroupBy,
} from "../../../shared/plugins/usage";
import type { TaskView } from "./api";
import { buttonClass, fieldClass } from "./controls";

const groupings: UsageGroupBy[] = [
  "bot",
  "provider",
  "model",
  "plugin",
  "task",
  "account",
  "kind",
  "day",
];

export function TaskUsage({ tasks }: { tasks: TaskView[] }) {
  const { state } = useStore();
  const [from, setFrom] = useState(
    new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("bot");
  const [botId, setBotId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [result, setResult] = useState<{
    groups: UsageAggregate[];
    entries: UsageEntry[];
    total: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({
    from,
    to,
    groupBy,
    offset: String(offset),
    ...(botId ? { botId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(accountId ? { accountId } : {}),
  }).toString();
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError("");
    void api<NonNullable<typeof result>>(`/api/usage/metering?${query}`, {
      signal: controller.signal,
      background: true,
    })
      .then((answer) => {
        if (!controller.signal.aborted) setResult(answer);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [query]);
  const label = (key: string) =>
    state.bots.find((bot) => bot.id === key)?.name ??
    tasks.find((task) => task.taskId === key)?.title ??
    key;
  return (
    <div className="task-usage">
      <div className="task-usage-filters">
        <label className="grid gap-1 text-xs">
          {t("tasks.from")}
          <input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setOffset(0);
            }}
            className={fieldClass}
          />
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.to")}
          <input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setOffset(0);
            }}
            className={fieldClass}
          />
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.groupBy")}
          <select
            className={fieldClass}
            value={groupBy}
            onChange={(event) => {
              setGroupBy(event.target.value as UsageGroupBy);
              setOffset(0);
            }}
          >
            {groupings.map((value) => (
              <option key={value} value={value}>
                {t(`tasks.group.${value}` as LocaleKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.bot")}
          <select
            className={fieldClass}
            value={botId}
            onChange={(event) => {
              setBotId(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">{t("tasks.all")}</option>
            {state.bots.map((bot) => (
              <option value={bot.id} key={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.taskName")}
          <select
            className={fieldClass}
            value={taskId}
            onChange={(event) => {
              setTaskId(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">{t("tasks.all")}</option>
            {tasks.map((task) => (
              <option value={task.taskId} key={task.taskId}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.group.account")}
          <input
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setOffset(0);
            }}
            placeholder={t("tasks.all")}
            className={fieldClass}
          />
        </label>
        <a
          href={`/api/usage/metering.csv?${query}`}
          download
          className={`${buttonClass} self-end text-center`}
        >
          {t("tasks.export")}
        </a>
      </div>
      {error && (
        <p role="alert" className="mb-4 break-words text-sm">
          {error}
        </p>
      )}
      {!result && !error && <p role="status">{t("tasks.loading")}</p>}
      {result && (
        <>
          <div className="overflow-x-auto rounded-xl border border-hairline">
            <table className="w-full text-left text-sm">
              <caption className="p-3 text-left font-semibold">
                {t("tasks.usage")}
              </caption>
              <thead className="bg-panel">
                <tr>
                  {[
                    "groupBy",
                    "quantity",
                    "actual",
                    "estimated",
                    "free",
                    "unknown",
                  ].map((key) => (
                    <th key={key} className="p-3">
                      {t(`tasks.${key}` as LocaleKey)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.groups.map((group) => (
                  <tr key={group.key} className="border-t border-hairline">
                    <th className="max-w-52 break-words p-3 font-normal">
                      {label(group.key)}
                    </th>
                    <td className="p-3">
                      {Object.entries(group.quantities).map(
                        ([unit, amount]) => (
                          <div key={unit}>
                            {amount?.toLocaleString()}{" "}
                            {t(`tasks.unit.${unit}` as LocaleKey)}
                          </div>
                        ),
                      )}
                    </td>
                    <td className="p-3">
                      {Object.entries(group.actual).map(
                        ([currency, amount]) => (
                          <div key={currency}>
                            {currency} {amount?.toFixed(4)}
                          </div>
                        ),
                      )}
                    </td>
                    <td className="p-3">
                      {Object.entries(group.estimated).map(
                        ([currency, amount]) => (
                          <div key={currency}>
                            {currency} {amount?.toFixed(4)}
                          </div>
                        ),
                      )}
                    </td>
                    <td className="p-3">{group.free}</td>
                    <td className="p-3">{group.unknown}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!result.groups.length && (
              <p className="p-4 text-sm text-ink-secondary">
                {t("tasks.noUsage")}
              </p>
            )}
          </div>
          <h2 className="mb-3 mt-6 font-semibold">
            {t("tasks.usageDetails")} · {result.total}
          </h2>
          <div className="overflow-x-auto rounded-xl border border-hairline">
            <table className="w-full text-left text-xs">
              <thead className="bg-panel">
                <tr>
                  {["at", "bot", "group.kind", "quantity", "cost"].map(
                    (key) => (
                      <th key={key} className="p-3">
                        {t(`tasks.${key}` as LocaleKey)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {result.entries.map((entry) => (
                  <tr key={entry.entryId} className="border-t border-hairline">
                    <td className="whitespace-nowrap p-3">
                      {new Date(entry.at).toLocaleString()}
                    </td>
                    <td className="max-w-44 break-words p-3">
                      {label(entry.botId)}
                    </td>
                    <td className="p-3">{entry.kind}</td>
                    <td className="whitespace-nowrap p-3">
                      {entry.quantity.toLocaleString()}{" "}
                      {t(`tasks.unit.${entry.unit}` as LocaleKey)}
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {t(`tasks.${entry.cost.state}` as LocaleKey)}{" "}
                      {entry.cost.currency} {entry.cost.amount?.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              className={buttonClass}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              {t("tasks.previous")}
            </button>
            <button
              className={buttonClass}
              disabled={offset + 100 >= result.total}
              onClick={() => setOffset(offset + 100)}
            >
              {t("tasks.next")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
