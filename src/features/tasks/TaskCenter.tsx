import "./tasks.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  LayoutGrid,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import {
  KANBAN_COLUMNS,
  type KanbanBoard,
  type KanbanColumn,
} from "../../../shared/plugins/tasks";
import { TaskDetails } from "./TaskDetails";
import { TaskUsage } from "./TaskUsage";
import { type TaskView, taskPath } from "./api";

import { fieldClass, buttonClass, columnLabel } from "./controls";

export function TaskCenter({ onClose }: { onClose(): void }) {
  const { state } = useStore();
  const [boards, setBoards] = useState<KanbanBoard[]>([]);
  const [boardId, setBoardId] = useState("");
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"tasks" | "usage">("tasks");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState<"board" | "task" | null>(null);
  const [newColumn, setNewColumn] = useState<KanbanColumn>("backlog");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const createInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) createInput.current?.focus();
  }, [creating]);
  const [newBoard, setNewBoard] = useState("");
  const [botId, setBotId] = useState("");
  const [source, setSource] = useState("");
  const [accountId, setAccountId] = useState("");
  const [archived, setArchived] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const currentBoard = useRef(boardId);
  currentBoard.current = boardId;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api<{ boards: KanbanBoard[] }>("/api/boards", {
      signal,
      background: true,
    });
    if (signal?.aborted) return;
    setBoards(result.boards);
    const id = currentBoard.current || result.boards[0]?.boardId || "";
    if (!id) {
      setLoading(false);
      return;
    }
    const answer = await api<{ tasks: TaskView[] }>(`/api/boards/${id}`, {
      signal,
      background: true,
    });
    if (
      signal?.aborted ||
      (currentBoard.current && currentBoard.current !== id)
    )
      return;
    setBoardId(id);
    setTasks(answer.tasks);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      void refresh(controller.signal).catch((failure: Error) => {
        if (!controller.signal.aborted) {
          setError(failure.message);
          setLoading(false);
        }
      });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh, boardId]);

  const perform = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
      await refresh().catch(() => {});
    } finally {
      setPending(false);
    }
  };
  const move = (task: TaskView, column: KanbanColumn) =>
    perform(() =>
      api(taskPath(task), {
        method: "PATCH",
        body: JSON.stringify({ revision: task.revision, column }),
      }),
    );
  const shown = tasks.filter(
    (task) =>
      Boolean(task.archivedAt) === archived &&
      (!botId || task.assigneeBotId === botId) &&
      (!source || task.source === source) &&
      (!accountId || task.accountId === accountId),
  );
  const picked = tasks.find((task) => task.taskId === selected);

  const filterCount = [botId, source, accountId, archived].filter(
    Boolean,
  ).length;
  const startTask = (column: KanbanColumn = "backlog") => {
    setNewColumn(column);
    setCreating("task");
  };

  return (
    <section className="task-center" aria-label={t("tasks.title")}>
      <header className="task-heading">
        <div className="task-heading-title">
          <button
            ref={close}
            onClick={onClose}
            aria-label={t("tasks.back")}
            className="task-icon-button"
          >
            <ArrowLeft size={16} />
          </button>
          <h1>{t("tasks.title")}</h1>
        </div>
        <nav className="task-tabs" aria-label={t("tasks.title")}>
          <button
            aria-pressed={tab === "tasks"}
            onClick={() => setTab("tasks")}
          >
            <LayoutGrid size={14} />
            {t("tasks.board")}
          </button>
          <button
            aria-pressed={tab === "usage"}
            onClick={() => setTab("usage")}
          >
            {t("tasks.usage")}
          </button>
        </nav>
        <div className="task-heading-actions">
          <button
            onClick={() => void perform(() => refresh())}
            disabled={pending}
            aria-label={t("tasks.refresh")}
            className="task-icon-button"
          >
            <RefreshCw size={15} />
          </button>
          {tab === "tasks" && (
            <button
              disabled={!boardId}
              onClick={() => startTask()}
              className="task-button task-primary"
            >
              <Plus size={14} />
              {t("tasks.newTask")}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      {tab === "usage" ? (
        <TaskUsage tasks={tasks} />
      ) : (
        <>
          <div className="task-toolbar">
            <div className="task-board-picker">
              <select
                aria-label={t("tasks.board")}
                value={boardId}
                onChange={(event) => {
                  setBoardId(event.target.value);
                  setTasks([]);
                  setSelected(null);
                  setLoading(true);
                }}
              >
                {!boards.length && (
                  <option value="">{t("tasks.noBoards")}</option>
                )}
                {boards.map((board) => (
                  <option key={board.boardId} value={board.boardId}>
                    {board.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setCreating("board")}
                className="task-icon-button"
                aria-label={t("tasks.newBoard")}
                title={t("tasks.newBoard")}
              >
                <Plus size={15} />
              </button>
            </div>
            <span className="task-toolbar-count">
              {shown.length} {t("tasks.group.task")}
            </span>
            <button
              className="task-button task-filter-toggle"
              aria-expanded={filtersOpen}
              aria-pressed={filterCount > 0}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal size={14} />
              {t("tasks.filters")}
              {filterCount > 0 && <span>{filterCount}</span>}
            </button>
          </div>
          {filtersOpen && (
            <div className="task-filter-bar">
              <label>
                {t("tasks.bot")}
                <select
                  value={botId}
                  onChange={(event) => setBotId(event.target.value)}
                  className={fieldClass}
                >
                  <option value="">{t("tasks.all")}</option>
                  {state.bots
                    .filter((bot) => !bot.hidden)
                    .map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {t("tasks.source")}
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  className={fieldClass}
                >
                  <option value="">{t("tasks.all")}</option>
                  {[
                    ...new Set(
                      tasks.map((task) => task.source).filter(Boolean),
                    ),
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("tasks.group.account")}
                <select
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  className={fieldClass}
                >
                  <option value="">{t("tasks.all")}</option>
                  {[
                    ...new Set(
                      tasks.map((task) => task.accountId).filter(Boolean),
                    ),
                  ].map((id) => (
                    <option key={id} value={id}>
                      {state.bots.find(
                        (bot) => bot.platformBinding?.accountId === id,
                      )?.name ?? id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="task-checkbox">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(event) => setArchived(event.target.checked)}
                />
                {t("tasks.archived")}
              </label>
            </div>
          )}
          {creating && (
            <div className="task-create-row">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    if (creating === "board") {
                      const answer = await api<{ board: KanbanBoard }>(
                        "/api/boards",
                        {
                          method: "POST",
                          body: JSON.stringify({ name: newBoard.trim() }),
                        },
                      );
                      currentBoard.current = answer.board.boardId;
                      setBoardId(answer.board.boardId);
                      setNewBoard("");
                    } else {
                      const answer = await api<{ task: TaskView }>(
                        `/api/boards/${boardId}/tasks`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            title: title.trim(),
                            column: newColumn,
                            ...(botId ? { assigneeBotId: botId } : {}),
                          }),
                        },
                      );
                      setSelected(answer.task.taskId);
                      setTitle("");
                    }
                    setCreating(null);
                  });
                }}
              >
                <Plus size={16} />
                <input
                  ref={createInput}
                  aria-label={t(
                    creating === "board" ? "tasks.boardName" : "tasks.taskName",
                  )}
                  placeholder={t(
                    creating === "board" ? "tasks.boardName" : "tasks.taskName",
                  )}
                  value={creating === "board" ? newBoard : title}
                  maxLength={creating === "board" ? 120 : 200}
                  onChange={(event) =>
                    (creating === "board" ? setNewBoard : setTitle)(
                      event.target.value,
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setCreating(null);
                  }}
                />
                <button
                  disabled={
                    pending || !(creating === "board" ? newBoard : title).trim()
                  }
                  className={buttonClass}
                >
                  {t(creating === "board" ? "tasks.newBoard" : "tasks.newTask")}
                </button>
                <button
                  type="button"
                  className="task-icon-button"
                  onClick={() => setCreating(null)}
                  aria-label={t("common.cancel")}
                >
                  <X size={15} />
                </button>
              </form>
            </div>
          )}
          <div className="task-workspace">
            {loading ? (
              <p role="status" className="task-loading">
                {t("tasks.loading")}
              </p>
            ) : !boards.length ? (
              <div className="task-empty">
                <LayoutGrid size={30} strokeWidth={1.25} />
                <h2>{t("tasks.noBoards")}</h2>
                <p>{t("tasks.start")}</p>
                <button
                  className="task-button task-primary"
                  onClick={() => setCreating("board")}
                >
                  <Plus size={14} />
                  {t("tasks.newBoard")}
                </button>
              </div>
            ) : (
              <div className="task-board" data-detail-open={Boolean(picked)}>
                {KANBAN_COLUMNS.map((column) => {
                  const columnTasks = shown.filter(
                    (task) => task.column === column,
                  );
                  const canCreate = ["backlog", "todo", "ready"].includes(
                    column,
                  );
                  return (
                    <section
                      key={column}
                      className="task-column"
                      data-column={column}
                      aria-label={columnLabel(column)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const task = tasks.find(
                          (item) =>
                            item.taskId ===
                            event.dataTransfer.getData("application/eac-task"),
                        );
                        if (task) void move(task, column);
                      }}
                    >
                      <h2>
                        <span className="task-status-dot" />
                        {columnLabel(column)}
                        <span className="task-column-count">
                          {columnTasks.length}
                        </span>
                        {canCreate && (
                          <button
                            onClick={() => startTask(column)}
                            aria-label={`${t("tasks.newTask")} · ${columnLabel(column)}`}
                            className="task-icon-button"
                          >
                            <Plus size={13} />
                          </button>
                        )}
                      </h2>
                      <div className="task-column-cards">
                        {columnTasks.map((task) => (
                          <button
                            key={task.taskId}
                            draggable={!pending}
                            onDragStart={(event) =>
                              event.dataTransfer.setData(
                                "application/eac-task",
                                task.taskId,
                              )
                            }
                            onClick={() => setSelected(task.taskId)}
                            aria-pressed={selected === task.taskId}
                            className="task-card"
                          >
                            <div className="task-card-top">
                              <span
                                className="task-priority"
                                data-priority={task.priority ?? "normal"}
                              >
                                {t(
                                  `tasks.priority.${task.priority ?? "normal"}` as LocaleKey,
                                )}
                              </span>
                              {task.source && (
                                <span className="task-card-source">
                                  {task.source}
                                </span>
                              )}
                              {task.column === "done" && <Check size={13} />}
                            </div>
                            <span className="task-card-title">
                              {task.title}
                            </span>
                            {task.description && (
                              <span className="task-card-description">
                                {task.description}
                              </span>
                            )}
                            <div className="task-card-footer">
                              <span className="task-card-avatar">
                                {(
                                  state.bots.find(
                                    (bot) => bot.id === task.assigneeBotId,
                                  )?.name ?? "—"
                                ).slice(0, 1)}
                              </span>
                              <span>
                                {state.bots.find(
                                  (bot) => bot.id === task.assigneeBotId,
                                )?.name ?? t("tasks.unassigned")}
                              </span>
                              <ArrowUpRight size={12} />
                            </div>
                            {task.nextRunAt && task.scheduleEnabled && (
                              <time>
                                {new Date(task.nextRunAt).toLocaleString()}
                              </time>
                            )}
                            {task.run?.error && (
                              <span className="task-card-error">
                                {task.run.error}
                              </span>
                            )}
                          </button>
                        ))}
                        {!columnTasks.length && (
                          <div className="task-column-empty" aria-hidden="true" />
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            {picked && (
              <TaskDetails
                key={picked.taskId}
                task={picked}
                tasks={tasks}
                pending={pending}
                perform={perform}
                onOpenChat={onClose}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
