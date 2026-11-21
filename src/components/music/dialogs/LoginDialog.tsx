// The Kugou sign-in dialog: the QR the person scans with the Kugou app, and the
// SMS code path for a phone number. Both are the account's own flow; nothing here
// sees the password.
import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { t } from "@/lib/music/ports";
import { musicStore } from "@/lib/music/store";
import { Button } from "@/lib/music/ports";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/lib/music/ports";
import { Chip, ChipRow, Field, Input, Notice } from "@/lib/music/ports";

type Mode = "qr" | "sms";

interface QrAnswer {
  qr?: { key: string; url: string; expiresAt: string };
  error?: { message: string };
}

interface PollAnswer {
  status?: "waiting" | "scanned" | "expired" | "success";
  error?: { message: string };
}

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("qr");
  const [qr, setQr] = useState<{ key: string; url: string } | null>(null);
  const [status, setStatus] = useState<"waiting" | "scanned" | "expired" | "success">("waiting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const stopPolling = () => {
    if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
    pollTimer.current = null;
  };

  const startQr = async () => {
    setBusy(true);
    setError(null);
    setStatus("waiting");
    try {
      const answer = await fetch("/api/music/login/qr", { method: "POST" }).then((response) => response.json() as Promise<QrAnswer>);
      if (answer.error) throw new Error(answer.error.message);
      if (!answer.qr) throw new Error(t("music.login.qrFailed"));
      setQr({ key: answer.qr.key, url: answer.qr.url });
      stopPolling();
      // The QR is short-lived; polling every two seconds is what the app itself does.
      pollTimer.current = window.setInterval(async () => {
        try {
          const polled = await fetch(`/api/music/login/qr?key=${encodeURIComponent(answer.qr!.key)}`).then((response) => response.json() as Promise<PollAnswer>);
          if (polled.status) setStatus(polled.status);
          if (polled.status === "success") {
            stopPolling();
            await musicStore.load();
            onClose();
          }
          if (polled.status === "expired") stopPolling();
        } catch {
          // A dropped poll is retried on the next tick.
        }
      }, 2_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) { stopPolling(); return; }
    void startQr();
    return () => stopPolling();
  }, [open]);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await fetch("/api/music/login/sms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobile: mobile.trim() }),
      }).then((response) => response.json() as Promise<{ error?: { message: string } }>);
      if (answer.error) throw new Error(answer.error.message);
      setCodeSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await fetch("/api/music/login/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobile: mobile.trim(), code: code.trim() }),
      }).then((response) => response.json() as Promise<{ error?: { message: string } }>);
      if (answer.error) throw new Error(answer.error.message);
      await musicStore.load();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {open && (
        <DialogContent>
          <DialogTitle>{t("music.login.title")}</DialogTitle>
          <DialogDescription>{t("music.login.body")}</DialogDescription>

          <ChipRow className="mt-3">
            <Chip active={mode === "qr"} onClick={() => setMode("qr")}>{t("music.login.qr")}</Chip>
            <Chip active={mode === "sms"} onClick={() => setMode("sms")}>{t("music.login.sms")}</Chip>
          </ChipRow>

          {error && <div className="mt-2"><Notice tone="bad">{error}</Notice></div>}

          {mode === "qr" && (
            <div className="mt-3 flex flex-col items-center gap-2">
              {qr ? (
                <div className="rounded-xl bg-white p-3">
                  <QRCodeSVG value={qr.url} size={188} level="M" bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : (
                <div className="grid size-[212px] place-items-center rounded-xl bg-inset text-ink-secondary">
                  {busy ? <Loader2 size={20} className="animate-spin" /> : null}
                </div>
              )}
              <p className="text-[12px] text-ink-secondary">
                {status === "scanned" ? t("music.login.scanned")
                  : status === "expired" ? t("music.login.expired")
                  : t("music.login.scanHint")}
              </p>
              {status === "expired" && <Button size="sm" variant="secondary" onClick={() => void startQr()}><RefreshCw size={12} /> {t("music.login.refresh")}</Button>}
            </div>
          )}

          {mode === "sms" && (
            <div className="mt-3 flex flex-col gap-2">
              <Field label={t("music.login.mobile")}>
                <Input value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="13800000000" inputMode="tel" />
              </Field>
              <Field label={t("music.login.code")}>
                <div className="flex gap-2">
                  <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="123456" inputMode="numeric" />
                  <Button size="sm" variant="secondary" disabled={busy || !mobile.trim()} onClick={() => void sendCode()}>
                    {codeSent ? t("music.login.resend") : t("music.login.sendCode")}
                  </Button>
                </div>
              </Field>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t("music.close")}</Button>
            {mode === "sms" && (
              <Button variant="primary" disabled={busy || !mobile.trim() || !code.trim()} onClick={() => void signIn()}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : null} {t("music.login.signIn")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
