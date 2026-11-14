import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { KanbanColumn } from "../../../shared/plugins/tasks";

export const fieldClass = "task-field";
export const buttonClass = "task-button";
export const columnLabel = (column: KanbanColumn) =>
  t(`tasks.column.${column}` as LocaleKey);
