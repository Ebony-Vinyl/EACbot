import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, openThread, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { KANBAN_COLUMNS } from "../../../shared/plugins/tasks";
import { taskPath, type TaskView } from "./api";
import { buttonClass, columnLabel, fieldClass } from "./controls";

export function TaskDetails({
  task,
  tasks,
  pending,
  perform,
  onClose,
  onOpenChat,
}: {
  task: TaskView;
  tasks: TaskView[];
  pending: boolean;
  perform(operation: () => Promise<unknown>): Promise<void>;
  onClose(): void;
  onOpenChat(): void;
}) {
  const { state, dispatch } = useStore();
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAction.current();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [botId, setBotId] = useState(task.assigneeBotId ?? "");
  const [priority, setPriority] = useState(task.priority ?? "normal");
  const [source, setSource] = useState(task.source ?? "");
  const [dependencies, setDependencies] = useState(task.dependsOn ?? []);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("comment");
  const [scheduleType, setScheduleType] = useState("once");
  const [at, setAt] = useState("");
  const [expression, setExpression] = useState("0 9 * * *");
  const [zone, setZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [revision, setRevision] = useState(task.revision);
  const dirty =
    title !== task.title ||
    description !== (task.description ?? "") ||
    botId !== (task.assigneeBotId ?? "") ||
    priority !== (task.priority ?? "normal") ||
    source !== (task.source ?? "") ||
    JSON.stringify(dependencies) !== JSON.stringify(task.dependsOn ?? []);
  useEffect(() => {
    if (!dirty) setRevision(task.revision);
  }, [task.revision, dirty]);
  const active = Boolean(
    task.run && ["queued", "running", "waiting"].includes(task.run.status),
  );
  const post = (action: string, body: Record<string, unknown> = {}) =>
    api(`${taskPath(task)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ revision: task.revision, ...body }),
    });
  const save = () =>
    perform(async () => {
      const answer = await api<{ task: TaskView }>(taskPath(task), {
        method: "PATCH",
        body: JSON.stringify({
          revision,
          title,
          description,
          assigneeBotId: botId || null,
          priority,
          source,
          dependsOn: dependencies,
        }),
      });
      setRevision(answer.task.revision);
    });

  return (
    <aside aria-label={t("tasks.details")} className="task-details">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">{t("tasks.details")}</h2>
        <button
          ref={closeButton}
          onClick={onClose}
          aria-label={t("tasks.close")}
          className="task-icon-button"
        >
          <X size={15} />
        </button>
      </header>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="grid gap-1 text-xs">
          {t("tasks.taskName")}
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
            className={fieldClass}
          />
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.description")}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={8000}
            rows={4}
            className={fieldClass}
          />
        </label>
        <label className="grid gap-1 text-xs">
          {t("tasks.bot")}
          <select
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            className={fieldClass}
          >
            <option value="">{t("tasks.unassigned")}</option>
            {state.bots
              .filter((bot) => !bot.hidden)
              .map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs">
            {t("tasks.priority")}
            <select
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as typeof priority)
              }
              className={fieldClass}
            >
              {["low", "normal", "high"].map((value) => (
                <option key={value} value={value}>
                  {t(`tasks.priority.${value}` as LocaleKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            {t("tasks.source")}
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              maxLength={120}
              className={fieldClass}
            />
          </label>
        </div>
        <fieldset className="grid max-h-40 gap-1 overflow-auto text-xs">
          <legend className="mb-1">{t("tasks.dependencies")}</legend>
          {tasks
            .filter(
              (entry) => entry.taskId !== task.taskId && !entry.archivedAt,
            )
            .map((entry) => (
              <label key={entry.taskId} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={dependencies.includes(entry.taskId)}
                  onChange={(event) =>
                    setDependencies(
                      event.target.checked
                        ? [...dependencies, entry.taskId]
                        : dependencies.filter((id) => id !== entry.taskId),
                    )
                  }
                />
                <span className="break-words">{entry.title}</span>
              </label>
            ))}
        </fieldset>
        <button
          disabled={pending || !dirty || active || Boolean(task.archivedAt)}
          className={buttonClass}
        >
          {t("tasks.save")}
        </button>
        {dirty && revision !== task.revision && (
          <div className="grid gap-2 text-xs" role="status">
            <p>{t("tasks.conflict")}</p>
            <button
              type="button"
              className={buttonClass}
              onClick={() => setRevision(task.revision)}
            >
              {t("tasks.rebase")}
            </button>
          </div>
        )}
      </form>
      <div className="my-4 grid gap-3 border-y border-hairline py-4">
        <label className="grid gap-1 text-xs">
          {t("tasks.status")}
          <select
            value={task.column}
            disabled={pending || active || dirty}
            onChange={(event) =>
              void perform(() =>
                api(taskPath(task), {
                  method: "PATCH",
                  body: JSON.stringify({
                    revision: task.revision,
                    column: event.target.value,
                  }),
                }),
              )
            }
            className={fieldClass}
          >
            {KANBAN_COLUMNS.map((column) => (
              <option
                key={column}
                value={column}
                disabled={column === "doing" || column === "scheduled"}
              >
                {columnLabel(column)}
              </option>
            ))}
          </select>
        </label>
        {task.run?.error && (
          <p role="status" className="break-words text-sm">
            {task.run.error}
          </p>
        )}
        <button
          disabled={
            pending || active || dirty || !botId || Boolean(task.archivedAt)
          }
          onClick={() => void perform(() => post("execute"))}
          className="task-button task-primary"
        >
          {t("tasks.run")}
        </button>
        {(active || task.scheduleEnabled) && (
          <button
            disabled={pending}
            onClick={() => void perform(() => post("cancel"))}
            className={buttonClass}
          >
            {t("tasks.stop")}
          </button>
        )}
        {task.run?.threadId && task.assigneeBotId && (
          <button
            className={buttonClass}
            onClick={() => {
              openThread(
                dispatch,
                { botId: task.assigneeBotId!, threadId: task.run!.threadId! },
                state,
                true,
              );
              onClose();
              onOpenChat();
            }}
          >
            {t("tasks.conversation")}
          </button>
        )}
        {task.scheduleEnabled && (
          <p className="text-xs">
            {t("tasks.nextRun")}{" "}
            {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"}
          </p>
        )}
        <details>
          <summary>{t("tasks.schedule")}</summary>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const schedule =
                scheduleType === "cron"
                  ? { type: "cron", expression, timeZone: zone }
                  : { type: "once", at: new Date(at).getTime() };
              void perform(() => post("schedule", { schedule }));
            }}
          >
            <label className="grid gap-1 text-xs">
              {t("tasks.schedule")}
              <select
                className={fieldClass}
                value={scheduleType}
                onChange={(event) => setScheduleType(event.target.value)}
              >
                <option value="once">{t("tasks.once")}</option>
                <option value="cron">Cron</option>
              </select>
            </label>
            {scheduleType === "cron" ? (
              <>
                <input
                  aria-label={t("tasks.cron")}
                  value={expression}
                  onChange={(event) => setExpression(event.target.value)}
                  className={fieldClass}
                  required
                />
                <input
                  aria-label={t("tasks.zone")}
                  value={zone}
                  onChange={(event) => setZone(event.target.value)}
                  className={fieldClass}
                  required
                />
              </>
            ) : (
              <input
                aria-label={t("tasks.at")}
                type="datetime-local"
                value={at}
                onChange={(event) => setAt(event.target.value)}
                required
                className={fieldClass}
              />
            )}
            <button
              disabled={
                pending || active || dirty || !botId || Boolean(task.archivedAt)
              }
              className={buttonClass}
            >
              {t("tasks.scheduleSave")}
            </button>
          </form>
        </details>
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t("tasks.artifacts")}</h3>
        {(task.artifacts ?? []).map((artifact, index) => (
          <article
            key={artifact.runId ?? index}
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app p-3 text-xs"
          >
            {artifact.text}
          </article>
        ))}
        <h3 className="mt-2 text-sm font-medium">{t("tasks.comments")}</h3>
        {(task.comments ?? []).map((comment) => (
          <p
            key={comment.id}
            className="whitespace-pre-wrap break-words rounded-lg bg-app p-3 text-xs"
          >
            {comment.text}
          </p>
        ))}
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              await post("notes", { kind, text: note });
              setNote("");
            });
          }}
        >
          <select
            aria-label={t("tasks.noteKind")}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className={fieldClass}
          >
            <option value="comment">{t("tasks.comments")}</option>
            <option value="artifact">{t("tasks.artifacts")}</option>
          </select>
          <textarea
            aria-label={t("tasks.note")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={4000}
            rows={2}
            className={fieldClass}
          />
          <button disabled={pending || !note.trim()} className={buttonClass}>
            {t("tasks.addNote")}
          </button>
        </form>
        <button
          disabled={pending || active}
          className={buttonClass}
          onClick={() =>
            void perform(() => post("archive", { archived: !task.archivedAt }))
          }
        >
          {t(task.archivedAt ? "tasks.restore" : "tasks.archive")}
        </button>
      </div>
    </aside>
  );
}
