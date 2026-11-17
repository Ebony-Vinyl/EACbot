/**
 * The two cards that block a run: an approval that needs allow/deny/answer,
 * and a question that needs an answer.
 *
 * Both state what the agent wants to do in the engine's own words. Neither
 * decides anything on its own: pressing a button calls the caller, which sends
 * one command and nothing else. An approval is painted in the warning colour
 * because it is the one row that stops the run until a person acts.
 */
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ApprovalFeedItem, QuestionFeedItem } from "./feed.ts";

const APPROVAL_LABELS = {
  pending: "等你决定",
  allowed: "已允许",
  denied: "已拒绝",
  answered: "已回答",
  expired: "已过期",
  cancelled: "已取消",
} as const;

const textareaClass =
  "w-full resize-y rounded-lg border border-hairline/40 bg-app px-2.5 py-1.5 text-[12px] leading-5 text-ink outline-none placeholder:text-ink-secondary focus:ring-1 focus:ring-accent/60";

export interface ApprovalCardProps {
  readonly approval: ApprovalFeedItem;
  /** Absent once the card is decided: nothing left to send. */
  readonly onDecide?: (decision: "allow" | "deny" | "answer", answer?: string) => void;
  readonly isBusy?: boolean;
}

export function ApprovalCard({ approval, onDecide, isBusy = false }: ApprovalCardProps): ReactNode {
  const [answer, setAnswer] = useState("");
  const [showingAnswer, setShowingAnswer] = useState(false);
  const pending = approval.status === "pending";
  const canAnswer = pending && onDecide !== undefined;
  const trimmed = answer.trim();

  return (
    <div
      className="flex w-full flex-col gap-2.5"
      data-testid={`approval-card-${approval.approvalId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px]",
            pending
              ? "bg-warning/15 text-warning"
              : approval.status === "denied"
                ? "bg-danger/15 text-danger"
                : "bg-success/15 text-success",
          )}
        >
          {APPROVAL_LABELS[approval.status]}
        </span>
        <span className="text-[12px] font-semibold text-ink">{approval.action}</span>
        <span className="text-[10px] text-ink-tertiary">{approval.at}</span>
      </div>

      {approval.detail.length > 0 && (
        <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-secondary">{approval.detail}</p>
      )}

      {approval.expiresAt !== undefined && pending && (
        <p className="text-[10px] text-ink-secondary">这个请求在 {approval.expiresAt} 之后过期。</p>
      )}

      {approval.answer !== undefined && <p className="text-[11px] text-ink">回答：{approval.answer}</p>}

      {canAnswer && showingAnswer && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-secondary">回答这个审批</span>
          <textarea
            className={textareaClass}
            value={answer}
            rows={3}
            placeholder="写清楚要 Agent 怎么做"
            onChange={(event) => setAnswer(event.currentTarget.value)}
          />
        </label>
      )}

      {canAnswer && (
        <div className="flex flex-wrap items-center gap-1.5">
          {showingAnswer ? (
            <>
              <Button variant="primary" size="sm" disabled={trimmed.length === 0 || isBusy} onClick={() => onDecide("answer", trimmed)}>
                发送回答
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowingAnswer(false)}>
                取消回答
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" disabled={isBusy} onClick={() => onDecide("allow")}>
                允许
              </Button>
              <Button variant="danger" size="sm" disabled={isBusy} onClick={() => onDecide("deny")}>
                拒绝
              </Button>
              <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => setShowingAnswer(true)}>
                改为回答
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface QuestionCardProps {
  readonly question: QuestionFeedItem;
  readonly onAnswer?: (answer: string) => void;
  readonly isBusy?: boolean;
}

export function QuestionCard({ question, onAnswer, isBusy = false }: QuestionCardProps): ReactNode {
  const [answer, setAnswer] = useState("");
  const trimmed = answer.trim();
  const open = question.answer === undefined && onAnswer !== undefined;

  return (
    <div className="flex w-full flex-col gap-2.5" data-testid="question-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[10px]", open ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary")}>
          {open ? "等你回答" : "已回答"}
        </span>
        <span className="text-[10px] text-ink-tertiary">{question.at}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[12px] font-medium text-ink">{question.question}</p>
      {question.answer !== undefined ? (
        <p className="text-[11px] text-ink-secondary">你回答：{question.answer}</p>
      ) : (
        open && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-ink-secondary">你的回答</span>
              <textarea
                className={textareaClass}
                value={answer}
                rows={3}
                placeholder="Agent 会按这段文字继续"
                onChange={(event) => setAnswer(event.currentTarget.value)}
              />
            </label>
            <Button variant="primary" size="sm" disabled={trimmed.length === 0 || isBusy} onClick={() => onAnswer(trimmed)}>
              发送回答
            </Button>
          </>
        )
      )}
    </div>
  );
}
