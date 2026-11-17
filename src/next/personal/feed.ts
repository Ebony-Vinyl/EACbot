import { t } from "@/lib/i18n";
/**
 * The conversation a mission's log describes, in the order a person reads it.
 *
 * A mission log interleaves adapter events (what the engine did) with
 * authority events (what this application decided). Only the types listed here
 * become conversation; anything else is left out rather than shown as a
 * generic row, because a row a person cannot act on is noise.
 */
import type { ApprovalStatus } from "../../../packages/agent-protocol/artifact.ts";
import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";

export type FeedTone = "info" | "success" | "error";

export interface UserFeedMessage {
  readonly kind: "user";
  readonly id: string;
  readonly at: string;
  readonly text: string;
}

export interface AssistantFeedMessage {
  readonly kind: "assistant";
  readonly id: string;
  readonly at: string;
  readonly text: string;
  /** True only for the newest block while its run is still live. */
  readonly streaming: boolean;
}

export interface OutputFeedItem {
  readonly kind: "output";
  readonly id: string;
  readonly at: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface ToolFeedItem {
  readonly kind: "tool";
  readonly id: string;
  readonly at: string;
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly status: "running" | "ok" | "failed";
  readonly output?: string;
}

export interface ApprovalFeedItem {
  readonly kind: "approval";
  readonly id: string;
  readonly at: string;
  readonly approvalId: string;
  readonly action: string;
  readonly detail: string;
  readonly status: ApprovalStatus;
  readonly expiresAt?: string;
  readonly answer?: string;
}

export interface QuestionFeedItem {
  readonly kind: "question";
  readonly id: string;
  readonly at: string;
  readonly question: string;
  readonly answer?: string;
}

export interface ArtifactFeedItem {
  readonly kind: "artifact";
  readonly id: string;
  readonly at: string;
  readonly artifactId: string;
  readonly path: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface ChildFeedItem {
  readonly kind: "child";
  readonly id: string;
  readonly at: string;
  readonly childMissionId: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
}

export interface NoticeFeedItem {
  readonly kind: "notice";
  readonly id: string;
  readonly at: string;
  readonly tone: FeedTone;
  readonly text: string;
}

export type FeedItem =
  | UserFeedMessage
  | AssistantFeedMessage
  | OutputFeedItem
  | ToolFeedItem
  | ApprovalFeedItem
  | QuestionFeedItem
  | ArtifactFeedItem
  | ChildFeedItem
  | NoticeFeedItem;

export interface FeedOptions {
  /** The mission's own prompt, shown before anything the log recorded. */
  readonly prompt?: string;
  readonly promptAt?: string;
  /** Whether the newest run is still producing output. */
  readonly live?: boolean;
}

/** Builds the conversation for `entries`, which must be in log order. */
export function buildFeed(entries: readonly MissionLogEntry[], options: FeedOptions = {}): FeedItem[] {
  const items: FeedItem[] = [];
  const tools = new Map<string, number>();
  const approvals = new Map<string, number>();
  let openAssistant: number | undefined;
  let openAssistantRun: string | undefined;

  const push = (item: FeedItem): void => {
    items.push(item);
    if (item.kind !== "assistant") {
      openAssistant = undefined;
      openAssistantRun = undefined;
    }
  };

  if (options.prompt !== undefined && options.prompt.trim().length > 0) {
    push({ kind: "user", id: "mission-prompt", at: options.promptAt ?? entries[0]?.at ?? "", text: options.prompt });
  }

  for (const entry of entries) {
    const payload = entry.payload;

    switch (entry.type) {
      case "run.output": {
        const text = stringField(payload, "text");
        if (text === undefined) break;
        const stream = payload.stream === "stderr" ? "stderr" : payload.stream === "stdout" ? "stdout" : "assistant";
        if (stream !== "assistant") {
          push({ kind: "output", id: entry.eventId, at: entry.at, stream, text });
          break;
        }
        const sameRun = openAssistant !== undefined && openAssistantRun === entry.runId;
        if (sameRun && openAssistant !== undefined) {
          const current = items[openAssistant] as AssistantFeedMessage;
          items[openAssistant] = { ...current, at: entry.at, text: current.text + text };
        } else {
          push({ kind: "assistant", id: entry.eventId, at: entry.at, text, streaming: false });
          openAssistant = items.length - 1;
          openAssistantRun = entry.runId;
        }
        break;
      }
      case "run.tool_call": {
        const callId = stringField(payload, "callId");
        const tool = stringField(payload, "tool");
        if (callId === undefined || tool === undefined) break;
        push({ kind: "tool", id: entry.eventId, at: entry.at, callId, tool, input: payload.input, status: "running" });
        tools.set(callId, items.length - 1);
        break;
      }
      case "run.tool_result": {
        const callId = stringField(payload, "callId");
        if (callId === undefined) break;
        const at = tools.get(callId);
        const output = stringField(payload, "output");
        const status = payload.ok === true ? "ok" : "failed";
        if (at === undefined) {
          push({
            kind: "tool",
            id: entry.eventId,
            at: entry.at,
            callId,
            tool: stringField(payload, "tool") ?? "tool",
            input: undefined,
            status,
            ...(output !== undefined ? { output } : {}),
          });
          tools.set(callId, items.length - 1);
        } else {
          const current = items[at] as ToolFeedItem;
          items[at] = { ...current, status, ...(output !== undefined ? { output } : {}) };
        }
        break;
      }
      case "run.approval_requested": {
        const approvalId = stringField(payload, "approvalId");
        if (approvalId === undefined) break;
        push({
          kind: "approval",
          id: entry.eventId,
          at: entry.at,
          approvalId,
          action: stringField(payload, "action") ?? "action",
          detail: stringField(payload, "detail") ?? "",
          status: "pending",
          ...optionalField("expiresAt", stringField(payload, "expiresAt")),
        });
        approvals.set(approvalId, items.length - 1);
        break;
      }
      case "run.approval_resolved":
      case "approval.resolved": {
        const approvalId = stringField(payload, "approvalId");
        if (approvalId === undefined) break;
        const at = approvals.get(approvalId);
        const decision = payload.decision;
        const status: ApprovalStatus =
          decision === "allow" || decision === "allowed" ? "allowed" : decision === "deny" || decision === "denied" ? "denied" : decision === "expired" ? "expired" : "answered";
        const answer = stringField(payload, "answer");
        if (at === undefined) break;
        const current = items[at] as ApprovalFeedItem;
        if (current.status !== "pending") break;
        items[at] = { ...current, status, ...(answer !== undefined ? { answer } : {}) };
        break;
      }
      case "run.waiting_input": {
        const question = stringField(payload, "question");
        if (question === undefined) break;
        push({ kind: "question", id: entry.eventId, at: entry.at, question });
        break;
      }
      case "run.input_received": {
        const input = stringField(payload, "input");
        if (input === undefined) break;
        const at = lastIndexOf(items, (item) => item.kind === "question" && item.answer === undefined);
        if (at !== undefined) items[at] = { ...(items[at] as QuestionFeedItem), answer: input };
        break;
      }
      case "run.steer_requested":
      case "run.input_submitted": {
        const input = stringField(payload, "input");
        if (input === undefined || input.trim().length === 0) break;
        push({ kind: "user", id: entry.eventId, at: entry.at, text: input });
        break;
      }
      case "run.artifact": {
        const artifactId = stringField(payload, "artifactId");
        const path = stringField(payload, "path");
        if (artifactId === undefined || path === undefined) break;
        push({
          kind: "artifact",
          id: entry.eventId,
          at: entry.at,
          artifactId,
          path,
          bytes: numberField(payload, "bytes") ?? 0,
          mediaType: stringField(payload, "mediaType") ?? "application/octet-stream",
        });
        break;
      }
      case "run.child_spawned": {
        const childMissionId = stringField(payload, "childMissionId");
        if (childMissionId === undefined) break;
        push({ kind: "child", id: entry.eventId, at: entry.at, childMissionId, status: "running" });
        break;
      }
      case "run.child_settled": {
        const childMissionId = stringField(payload, "childMissionId");
        if (childMissionId === undefined) break;
        const status = payload.status === "succeeded" || payload.status === "failed" || payload.status === "cancelled" ? payload.status : "running";
        const at = lastIndexOf(items, (item) => item.kind === "child" && item.childMissionId === childMissionId && item.status === "running");
        if (at !== undefined) items[at] = { ...(items[at] as ChildFeedItem), status };
        else push({ kind: "child", id: entry.eventId, at: entry.at, childMissionId, status });
        break;
      }
      case "run.started":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "info", text: t("workspaceUi.copy62") });
        break;
      case "run.completed":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "success", text: stringField(payload, "summary") ?? "Run completed" });
        break;
      case "run.failed":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "error", text: stringField(payload, "message") ?? "Run failed" });
        break;
      case "run.cancelled":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "info", text: t("workspaceUi.copy58") });
        break;
      case "run.interrupted":
        push({
          kind: "notice",
          id: entry.eventId,
          at: entry.at,
          tone: "info",
          text: payload.resumable === false ? t("workspaceUi.copy59") : t("workspaceUi.copy60"),
        });
        break;
      case "run.resumed":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "info", text: t("workspaceUi.copy61") });
        break;
      case "run.usage": {
        const parts: string[] = [];
        const input = numberField(payload, "inputTokens");
        const output = numberField(payload, "outputTokens");
        const cost = numberField(payload, "costUsd");
        if (input !== undefined) parts.push(`${input} input tokens`);
        if (output !== undefined) parts.push(`${output} output tokens`);
        if (cost !== undefined) parts.push(`$${cost.toFixed(4)}`);
        if (parts.length > 0) push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "info", text: parts.join(" · ") });
        break;
      }
      case "mission.cancelled":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "info", text: t("workspaceUi.copy38") });
        break;
      case "mission.woken":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "info", text: t("workspaceUi.copy32") });
        break;
      case "run.start_failed":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "error", text: stringField(payload, "message") ?? "The run could not start" });
        break;
      case "run.steer_refused":
      case "run.steer_failed":
        push({
          kind: "notice",
          id: entry.eventId,
          at: entry.at,
          tone: "error",
          text: stringField(payload, "reason") ?? "The message was not delivered to the agent",
        });
        break;
      case "run.control_pending":
        push({ kind: "notice", id: entry.eventId, at: entry.at, tone: "error", text: t("workspaceUi.copy29") });
        break;
      default:
        break;
    }
  }

  if (options.live === true && openAssistant !== undefined) {
    items[openAssistant] = { ...(items[openAssistant] as AssistantFeedMessage), streaming: true };
  }
  return items;
}

/** The approvals still awaiting a person, newest last. */
export function pendingApprovals(items: readonly FeedItem[]): ApprovalFeedItem[] {
  return items.filter((item): item is ApprovalFeedItem => item.kind === "approval" && item.status === "pending");
}

/** The question the run is blocked on, if any. */
export function openQuestion(items: readonly FeedItem[]): QuestionFeedItem | undefined {
  return [...items].reverse().find((item): item is QuestionFeedItem => item.kind === "question" && item.answer === undefined);
}

function lastIndexOf(items: readonly FeedItem[], match: (item: FeedItem) => boolean): number | undefined {
  for (let at = items.length - 1; at >= 0; at -= 1) if (match(items[at] as FeedItem)) return at;
  return undefined;
}

function stringField(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" ? value : undefined;
}

function numberField(payload: Record<string, unknown>, name: string): number | undefined {
  const value = payload[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalField<K extends string>(name: K, value: string | undefined): Partial<Record<K, string>> {
  return value !== undefined ? ({ [name]: value } as Partial<Record<K, string>>) : {};
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
