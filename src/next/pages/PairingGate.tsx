/** The pairing gate: the code the local core printed is the only way a new
 * device gets in, so a page that reads `/api/v1` shows this instead of a pane
 * full of 401s.
 *
 * It is the app's own card on the app's own ground, so the first screen a
 * person sees already looks like the product. */

import { useState } from "react";
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
      className="flex min-h-0 flex-1 items-center justify-center p-6"
    >
      <Card className="w-full max-w-[420px] border-hairline/40 bg-menu p-5 shadow-2xl">
        <h2 className="text-[14px] font-semibold text-ink">Pair this device</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          The core printed a one-time code in its terminal. Enter it here to keep a device session.
        </p>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void claim();
          }}
        >
          <Field label="Pairing code">
            <Input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              disabled={busy}
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
            {busy ? "Pairing…" : "Pair"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
