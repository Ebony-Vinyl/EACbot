/** The pairing gate: the code the local core printed is the only way a new
 * device gets in, so a page that reads `/api/v1` shows this instead of a pane
 * full of 401s.
 *
 * It is the app's own card on the app's own ground, so the first screen a
 * person sees already looks like the product. */

import { useState } from "react";
import { Link2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { useAuth } from "../foundation/api.ts";

export function PairingGate() {
  const auth = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (auth.status === "paired") return null;

  const claim = async (): Promise<void> => {
    const trimmed = code.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setProblem(null);
    try {
      await auth.claim({ code: trimmed, label: "EACbot" });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "pairing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="workbench-pairing"
      className="neutral-pairing"
    >
      <Card className="neutral-pairing-card">
        <span className="neutral-pairing-icon"><Link2 size={22} strokeWidth={1.5} aria-hidden="true" /></span>
        <h2>连接任务服务</h2>
        <p>
          将这个工作空间连接到你的任务服务。输入服务启动终端显示的一次性配对码，即可开始使用。
        </p>
        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void claim();
          }}
        >
          <Field label="配对码">
            <Input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              disabled={busy}
              className="neutral-pairing-code"
              autoComplete="one-time-code"
              spellCheck={false}
              autoFocus
              data-testid="workbench-pairing-code"
            />
          </Field>
          {problem !== null && (
            <p role="alert" data-testid="workbench-pairing-error" className="text-[11px] text-danger">
              {problem}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy || code.trim().length === 0}
            data-testid="workbench-pairing-submit"
          >
            {busy ? "连接中…" : "连接"}
          </Button>
        </form>
        <div className="neutral-pairing-note"><ShieldCheck size={14} aria-hidden="true" />已有机器人聊天可以继续使用</div>
      </Card>
    </div>
  );
}
