/**
 * The cloud desktop, in the three places a person meets it.
 *
 * 1. A handoff card in the conversation, when an agent wants a person to take
 *    over its screen.
 * 2. A preview beside the conversation, so the screen can be watched without
 *    leaving the task.
 * 3. A full-screen canvas that accepts input.
 *
 * All three read the same state, and the picture is scaled by its container's
 * aspect ratio rather than by a transform: a transformed frame moves the
 * pointer's coordinates away from where the remote machine thinks they are.
 *
 * A dropped connection keeps the last frame on screen and says it is
 * reconnecting. Clearing the picture would tell a person their session ended
 * when it did not.
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { ENTER_CLASS } from "./motion.ts";

export type DesktopStatus = "off" | "starting" | "running" | "sleeping" | "reconnecting" | "error";

export interface DesktopState {
  readonly status: DesktopStatus;
  /** The most recent frame, kept across a reconnect so the screen never blanks
   * on a drop. */
  readonly lastFrameUrl?: string;
  readonly detail?: string;
  /** When this frame was captured, so a stale picture says how stale it is. */
  readonly frameAt?: string;
  /** True while this client holds the input lease. */
  readonly controlling?: boolean;
}

/** What a handoff card can be answered with. `skip` is a refusal that also
 * tells the agent to move on, which is why it never looks like "done". */
export type HandoffDecision = "takeOver" | "done" | "skip";

export interface HandoffCardProps {
  readonly state: DesktopState;
  readonly onDecide: (decision: HandoffDecision) => void;
  readonly onOpenPreview?: () => void;
  readonly isBusy?: boolean;
}

export function HandoffCard({ state, onDecide, onOpenPreview, isBusy = false }: HandoffCardProps): ReactNode {
  const unavailable = state.status === "off" || state.status === "error";
  return (
    <Card className={cn("flex w-full flex-col gap-2.5 p-4", ENTER_CLASS)} data-testid="desktop-handoff">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={state.status} />
        <p className="text-[12px] font-medium text-ink">Agent 需要你在这台电脑上接手一下</p>
      </div>
      <p className="text-[10px] leading-relaxed text-ink-secondary">
        接手之后，你的鼠标和键盘会进入这台电脑。结束时会交还给 Agent，它会继续这一步。
      </p>
      {state.lastFrameUrl !== undefined && (
        <button
          type="button"
          onClick={onOpenPreview}
          className="cursor-pointer overflow-hidden rounded-lg border border-hairline/40"
          aria-label="打开桌面预览"
        >
          <DesktopFrame state={state} />
        </button>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={unavailable || isBusy} onClick={() => onDecide("takeOver")}>
          {isBusy ? "接手…" : "接手"}
        </Button>
        <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => onDecide("done")}>
          我做完了
        </Button>
        <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => onDecide("skip")}>
          跳过这一步
        </Button>
      </div>
      <p className="text-[10px] text-ink-secondary">“跳过这一步”表示不接手，Agent 会跳过它而不是等你完成。</p>
    </Card>
  );
}

export interface DesktopPreviewProps {
  readonly state: DesktopState;
  readonly onExpand: () => void;
  readonly onRetry: () => void;
}

/** The right-panel preview. It shares one state with the full-screen view, so
 * opening full screen never reconnects. */
export function DesktopPreview({ state, onExpand, onRetry }: DesktopPreviewProps): ReactNode {
  return (
    <section className="flex flex-col gap-2 p-3" data-testid="desktop-preview">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">云桌面</h2>
        <StatusChip status={state.status} />
      </div>
      <DesktopFrame state={state} />
      <ConnectionNotice state={state} onRetry={onRetry} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="secondary" size="sm" disabled={state.status === "off"} onClick={onExpand}>
          全屏
        </Button>
        <Button variant="ghost" size="sm" disabled={state.status !== "error" && state.status !== "reconnecting"} onClick={onRetry}>
          重试
        </Button>
      </div>
    </section>
  );
}

export interface DesktopFullScreenProps {
  readonly state: DesktopState;
  readonly onExit: () => void;
  readonly onRetry: () => void;
  readonly onRelease: () => void;
}

/** The full-screen canvas. The frame is the focusable region and the controls
 * keep their own focus, so a keyboard user is never trapped in the picture. */
export function DesktopFullScreen({ state, onExit, onRetry, onRelease }: DesktopFullScreenProps): ReactNode {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-app" data-testid="desktop-fullscreen">
      <header className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">云桌面</h2>
        <StatusChip status={state.status} />
        <Button variant="secondary" size="sm" disabled={!state.controlling} onClick={onRelease}>
          交还控制
        </Button>
        <Button variant="ghost" size="sm" disabled={state.status !== "error" && state.status !== "reconnecting"} onClick={onRetry}>
          重试
        </Button>
        <Button variant="ghost" size="sm" onClick={onExit}>
          退出全屏
        </Button>
      </header>
      <div className="min-h-0 flex-1 p-2">
        <DesktopFrame state={state} isFullScreen />
      </div>
      <ConnectionNotice state={state} onRetry={onRetry} />
    </div>
  );
}

/** The picture itself. `object-contain` scales by the container's ratio, which
 * keeps the remote pointer where the remote machine expects it. */
export function DesktopFrame({ state, isFullScreen = false }: { readonly state: DesktopState; readonly isFullScreen?: boolean }): ReactNode {
  const empty = state.lastFrameUrl === undefined;
  return (
    <div
      tabIndex={0}
      role="img"
      aria-label={empty ? "云桌面画面还没有到达" : `云桌面画面，${statusWord(state.status)}`}
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-lg bg-inset",
        isFullScreen ? "h-full w-full" : "aspect-video w-full",
      )}
      data-testid="desktop-frame"
    >
      {empty ? (
        <p className="px-6 text-center text-[11px] text-ink-secondary">
          {state.status === "starting" ? "正在连接这台电脑的画面" : "还没有收到画面"}
        </p>
      ) : (
        <img src={state.lastFrameUrl} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
      )}
      {state.status === "reconnecting" && (
        <div className="absolute inset-0 flex items-center justify-center" data-testid="desktop-reconnecting">
          <span className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />
          <span className="relative rounded-full bg-card px-3 py-1.5 ring-1 ring-hairline/60">
            <span className="animate-pulse text-[11px] font-medium text-ink motion-reduce:animate-none">正在重新连接</span>
          </span>
        </div>
      )}
    </div>
  );
}

function ConnectionNotice({ state, onRetry }: { readonly state: DesktopState; readonly onRetry: () => void }): ReactNode {
  if (state.status !== "reconnecting" && state.status !== "error") {
    return state.frameAt !== undefined ? <p className="text-[10px] text-ink-secondary">画面来自 {state.frameAt}。</p> : null;
  }
  return (
    <div className="flex items-start gap-2 px-1" role="status" aria-live="polite">
      <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-ink-secondary">
        {state.status === "reconnecting"
          ? "连接中断，保留最后一帧。重连不会重放你的旧输入。"
          : (state.detail ?? "连接失败。保留最后一帧。")}
      </p>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

const STATUS_TONE: Readonly<Record<DesktopStatus, string>> = {
  off: "bg-raised text-ink-secondary",
  starting: "bg-accent/15 text-accent",
  running: "bg-success/15 text-success",
  sleeping: "bg-accent/15 text-accent",
  reconnecting: "bg-warning/15 text-warning",
  error: "bg-danger/15 text-danger",
};

function StatusChip({ status }: { readonly status: DesktopStatus }): ReactNode {
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px]", STATUS_TONE[status])}>{statusWord(status)}</span>;
}

function statusWord(status: DesktopStatus): string {
  switch (status) {
    case "off":
      return "未启动";
    case "starting":
      return "正在启动";
    case "running":
      return "运行中";
    case "sleeping":
      return "休眠";
    case "reconnecting":
      return "重连中";
    case "error":
      return "连接出错";
  }
}
