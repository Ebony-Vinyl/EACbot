import { api } from "@/state/api";
import type { KanbanTask } from "../../../shared/plugins/tasks";
import type { RoutineSchedule } from "../../../shared/routines";

export type TaskView = KanbanTask & {
  schedule?: RoutineSchedule;
  nextRunAt?: number | null;
  scheduleEnabled?: boolean;
};

export async function readTaskBoards(
  signal?: AbortSignal,
): Promise<TaskView[]> {
  const { tasks } = await api<{ tasks: TaskView[] }>("/api/boards/tasks", {
    signal,
    background: true,
  });
  return tasks;
}

export function taskPath(task: KanbanTask): string {
  return `/api/boards/${task.boardId}/tasks/${task.taskId}`;
}
