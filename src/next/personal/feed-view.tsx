/**
 * The conversation a mission's log describes.
 *
 * The log is the only source: every row here came from a structured event the
 * authority recorded, and the order is the log's own. Nothing in this view
 * decides what a run is doing — it renders what the run reported, and a
 * notification is what tells it to read again.
 *
 * Bubbles follow the app's own chat grammar: the person's words sit on the
 * right in the raised bubble colour, the agent's on the left on the panel
 * colour, and everything the engine emitted (tool calls, output, approvals)
 * is a full-width card on the inset colour so a scan never mistakes a log line
 * for something Hermes said.
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { FeedItem, ToolFeedItem } from "./feed.ts";
import { formatBytes } from "./feed.ts";
import { ApprovalCard, QuestionCard } from "./cards.tsx";

export interface FeedProps {
  readonly items: readonly FeedItem[];
  readonly live: boolean;
  readonly onDecide?: (approvalId: string, decision: "allow" | "deny" | "answer", answer?: string) => void;
  readonly onAnswerQuestion?: (answer: string) => void;
  readonly busyApprovalId?: string;
}

export function Feed({ items, live, onDecide, onAnswerQuestion, busyApprovalId }: FeedProps): ReactNode {
  return (
    <div className="flex flex-col gap-2.5" data-live={live ? "" : undefined}>
      {items.map((item) => (
        <FeedRow
          key={item.id}
          item={item}
          {...(onDecide !== undefined ? { onDecide } : {})}
          {...(onAnswerQuestion !== undefined ? { onAnswerQuestion } : {})}
          {...(busyApprovalId !== undefined ? { busyApprovalId } : {})}
        />
      ))}
    </div>
  );
}

function FeedRow({
  item,
  onDecide,
  onAnswerQuestion,
  busyApprovalId,
}: {
  readonly item: FeedItem;
  readonly onDecide?: (approvalId: string, decision: "allow" | "deny" | "answer", answer?: string) => void;
  readonly onAnswerQuestion?: (answer: string) => void;
  readonly busyApprovalId?: string;
}): ReactNode {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-[14px] bg-[color:var(--color-bubble-user)] px-3 py-2 text-[13px] leading-5 text-[color:var(--color-bubble-user-ink)]">
            <p className="whitespace-pre-wrap break-words">{item.text}</p>
            <p className="mt-1 text-right text-[10px] opacity-60">{item.at}</p>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-[14px] bg-raised px-3 py-2 text-[13px] leading-5 text-ink">
            <p className="whitespace-pre-wrap break-words">{item.text}</p>
            <p className="mt-1 text-[10px] text-ink-tertiary">{item.streaming ? "正在输出" : item.at}</p>
          </div>
        </div>
      );    case "output":
      return (
        <LogCard>
          <details>
            <summary className="cursor-pointer select-none text-[11px] text-ink-secondary">
              {item.stream === "stderr" ? "标准错误" : "标准输出"} · {item.text.split("\n").length} 行
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-ink">
              {item.text}
            </pre>
          </details>
        </LogCard>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "approval":
      return (
        <LogCard>
          <ApprovalCard
            approval={item}
            {...(onDecide !== undefined && item.status === "pending"
              ? { onDecide: (decision, answer) => onDecide(item.approvalId, decision, answer) }
              : {})}
            isBusy={busyApprovalId === item.approvalId}
          />
        </LogCard>
      );
    case "question":
      return (
        <LogCard>
          <QuestionCard
            question={item}
            {...(onAnswerQuestion !== undefined && item.answer === undefined ? { onAnswer: onAnswerQuestion } : {})}
          />
        </LogCard>
      );
    case "artifact":
      return (
        <LogCard testId="artifact-row">
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[12px] font-medium text-ink">{item.path}</span>
              <span className="text-[10px] text-ink-secondary">
                {item.mediaType} · {formatBytes(item.bytes)}
              </span>
            </div>
            <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">产物</span>
          </div>
        </LogCard>
      );
    case "child":
      return (
        <LogCard>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className={cn("rounded-full px-2 py-0.5 text-[10px]", childTone(item.status))}>
              {childLabel(item.status)}
            </span>
            <span className="font-mono text-[10px] text-ink-secondary">{item.childMissionId}</span>
          </div>
        </LogCard>
      );
    case "notice":
      return (
        <LogCard>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px]",
                item.tone === "error"
                  ? "bg-danger/15 text-danger"
                  : item.tone === "success"
                    ? "bg-success/15 text-success"
                    : "bg-raised text-ink-secondary",
              )}
            >
              {noticeLabel(item.tone)}
            </span>
            <span className="break-words text-[11px] text-ink-secondary">{item.text}</span>
            <span className="text-[10px] text-ink-tertiary">{item.at}</span>
          </div>
        </LogCard>
      );
  }
}

function childTone(status: "running" | "succeeded" | "failed" | "cancelled"): string {
  if (status === "running") return "bg-accent/15 text-accent";
  if (status === "succeeded") return "bg-success/15 text-success";
  if (status === "failed") return "bg-danger/15 text-danger";
  return "bg-raised text-ink-secondary";
}

function childLabel(status: "running" | "succeeded" | "failed" | "cancelled"): string {
  if (status === "running") return "子任务进行中";
  if (status === "succeeded") return "子任务完成";
  if (status === "failed") return "子任务失败";
  return "子任务取消";
}

function noticeLabel(tone: "info" | "success" | "error"): string {
  return tone === "error" ? "错误" : tone === "success" ? "完成" : "进展";
}

/** A full-width row for anything the engine produced rather than said. */
function LogCard({ children, testId }: { readonly children: ReactNode; readonly testId?: string }): ReactNode {
  return (
    <Card
      className="w-full border-hairline/30 bg-inset/60 px-3 py-2"
      {...(testId !== undefined ? { "data-testid": testId } : {})}
    >
      {children}
    </Card>
  );
}

/** A tool call with the engine's own input and output, collapsed until asked
 * for: a person scanning a run wants the calls, not every byte they printed. */
function ToolRow({ item }: { readonly item: ToolFeedItem }): ReactNode {
  const input = item.input === undefined ? undefined : JSON.stringify(item.input, null, 2);
  return (
    <LogCard testId={`tool-row-${item.callId}`}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px]",
              item.status === "running"
                ? "bg-accent/15 text-accent"
                : item.status === "ok"
                  ? "bg-success/15 text-success"
                  : "bg-danger/15 text-danger",
            )}
          >
            {item.status === "running" ? "运行中" : item.status === "ok" ? "成功" : "失败"}
          </span>
          <span className="break-all font-mono text-[11px] font-medium text-ink">{item.tool}</span>
          <span className="text-[10px] text-ink-tertiary">{item.at}</span>
        </div>
        {(input !== undefined || item.output !== undefined) && (
          <details>
            <summary className="cursor-pointer select-none text-[11px] text-ink-secondary">输入与输出</summary>
            {input !== undefined && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app/60 p-2 font-mono text-[11px] leading-5 text-ink">
                {input}
              </pre>
            )}
            {item.output !== undefined && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app/60 p-2 font-mono text-[11px] leading-5 text-ink">
                {item.output}
              </pre>
            )}
          </details>
        )}
      </div>
    </LogCard>
  );
}

/** The composer above the feed. A disabled composer always says why, because a
 * person pressing a dead control learns nothing. */
export function ComposerBar({
  value,
  onChange,
  onSend,
  disabledReason,
  isBusy,
  canInterrupt,
  onInterrupt,
  canResume,
  onResume,
  canCancel,
  onCancel,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly disabledReason?: string;
  readonly isBusy: boolean;
  readonly canInterrupt: boolean;
  readonly onInterrupt: () => void;
  readonly canResume: boolean;
  readonly onResume: () => void;
  readonly canCancel: boolean;
  readonly onCancel: () => void;
}): ReactNode {
  const trimmed = value.trim();
  const blocked = disabledReason !== undefined;
  return (
    <div className="flex w-full flex-col gap-2" data-testid="mission-composer">
      <textarea
        aria-label="给这个任务追加指令"
        className="min-h-16 w-full resize-y rounded-[14px] bg-ink/[0.045] px-3 py-2 text-[13px] leading-5 text-ink outline-none ring-[0.5px] ring-ink/[0.14] placeholder:text-ink-tertiary focus-visible:ring-ink/30"
        value={value}
        rows={2}
        placeholder={blocked ? disabledReason : "追加一句：Hermes 会在下一个工具边界收到"}
        disabled={blocked}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!blocked && trimmed.length > 0) onSend();
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={blocked || trimmed.length === 0 || isBusy} onClick={onSend}>
          {isBusy ? "发送中…" : "发送"}
        </Button>
        {canInterrupt && (
          <Button variant="secondary" size="sm" disabled={isBusy} onClick={onInterrupt}>
            中断
          </Button>
        )}
        {canResume && (
          <Button variant="secondary" size="sm" disabled={isBusy} onClick={onResume}>
            恢复
          </Button>
        )}
        {canCancel && (
          <Button variant="danger" size="sm" disabled={isBusy} onClick={onCancel}>
            取消任务
          </Button>
        )}
      </div>
      {blocked && <p className="text-[10px] text-ink-secondary">{disabledReason}</p>}
    </div>
  );
}
