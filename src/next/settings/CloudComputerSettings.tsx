/**
 * The cloud computer section: add a computer the person owns, test it, and
 * remove it.
 *
 * The form collects connection facts only. There is no password field and no
 * private-key field anywhere on this screen, because the environment agent
 * resolves credentials itself: a key typed into a browser is a key in a
 * browser's memory, its devtools and its crash dumps. This application owns
 * its own known-hosts file and generates it in its data directory, so a person
 * never names a path for it, and a sign-in mode belongs to an agent instance,
 * so it is chosen in Agent settings.
 */
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { actionFailureMessage, environmentActions, useEnvironments } from "../personal/foundation.ts";
import type { Loadable } from "../personal/port.ts";
import { LoadableView } from "../personal/ui.tsx";
import {
  EMPTY_DRAFT, describeConnection, environmentRequest, hasPin, hostKeyWarning, parsePort, validateDraft,
  type ConnectionReport, type DraftField, type EnvironmentRecord, type FieldErrors, type SshDraft,
} from "./environment.ts";

/** Re-reads the list after a change. A list that was not ready has nothing to
 * refresh, and its own retry is the way back. */
function refreshIfReady(state: Loadable<unknown>): void {
  if (state.status === "ready") state.refresh();
}

const STATUS_TONE: Readonly<Record<string, string>> = {
  online: "bg-success/15 text-success",
  hostKeyChanged: "bg-danger/15 text-danger",
  offline: "bg-warning/15 text-warning",
};

export function CloudComputerSettings(): ReactNode {
  const environments = useEnvironments();
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [report, setReport] = useState<{ readonly id: string; readonly report: ConnectionReport } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<EnvironmentRecord | null>(null);

  const test = async (id: string): Promise<void> => {
    setBusyId(id);
    setFailure(null);
    try {
      const result = await environmentActions.test(id);
      setReport({ id, report: result });
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (record: EnvironmentRecord): Promise<void> => {
    setBusyId(record.id);
    setFailure(null);
    try {
      await environmentActions.remove(record.id);
      setConfirmingRemove(null);
      refreshIfReady(environments);
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-testid="cloud-computer-settings">
      <header className="flex flex-col gap-1">
        <h2 className="text-[12px] font-semibold text-ink">我的云电脑</h2>
        <p className="text-[10px] leading-relaxed text-ink-secondary">
          这台电脑是你自己的，通过 SSH 连接。EACbot 不销售云电脑，也不内置任何云供应商；这里只记录连接事实和一台主机的指纹，known-hosts 文件由应用自己维护。
        </p>
      </header>

      {failure !== null && <Notice title="操作没有完成" detail={failure} onDismiss={() => setFailure(null)} />}

      <LoadableView state={environments} label="正在读取已连接的电脑" what="云电脑设置">
        {(records) =>
          records.length === 0 && !adding ? (
            <Card className="flex flex-col items-start gap-2 p-4" data-testid="cloud-computer-empty">
              <p className="text-[12px] font-medium text-ink">还没有连接任何电脑</p>
              <p className="text-[11px] leading-relaxed text-ink-secondary">
                任何支持 SSH 的 Linux 电脑都可以。需要主机地址、端口、一个非 root 账号，以及那台电脑打印的主机指纹。
              </p>
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                添加我的电脑
              </Button>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {records.map((record) => (
                <ComputerRow
                  key={record.id}
                  record={record}
                  busy={busyId === record.id}
                  report={report?.id === record.id ? report.report : record.lastTest}
                  onTest={() => void test(record.id)}
                  onRemove={() => setConfirmingRemove(record)}
                />
              ))}
              {!adding && (
                <div>
                  <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                    添加另一台电脑
                  </Button>
                </div>
              )}
            </div>
          )
        }
      </LoadableView>

      {adding && (
        <AddComputerForm
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refreshIfReady(environments);
          }}
        />
      )}

      <Dialog open={confirmingRemove !== null} onOpenChange={(open) => !open && setConfirmingRemove(null)}>
        <DialogContent className="max-w-[460px]">
          <DialogTitle>删除这台电脑？</DialogTitle>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
            {confirmingRemove === null
              ? ""
              : `删除 ${confirmingRemove.label} 会移除它的连接记录和固定的主机指纹。这台电脑上的 Agent 和任务不会被改动。要重新连接，就按同样的信息重新添加，并再次确认指纹。`}
          </p>
          <div className="mt-4 flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => confirmingRemove !== null && void remove(confirmingRemove)}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ComputerRow({
  record,
  busy,
  report,
  onTest,
  onRemove,
}: {
  readonly record: EnvironmentRecord;
  readonly busy: boolean;
  readonly report: ConnectionReport | undefined;
  readonly onTest: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const described = describeConnection(report);
  const changed = hostKeyWarning(record.status);
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid={`computer-row-${record.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-[12px] font-medium text-ink">{record.label}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px]",
            STATUS_TONE[record.status ?? "unknown"] ?? "bg-raised text-ink-secondary",
          )}
        >
          {record.status ?? "unknown"}
        </span>
        <span className="font-mono text-[10px] text-ink-secondary">
          {record.user}@{record.host}:{record.port}
        </span>
      </div>
      <p className="break-all font-mono text-[10px] text-ink-secondary">
        {hasPin(record) ? record.hostKeyFingerprint : "没有记录主机指纹"}
      </p>
      <p className={cn("text-[10px]", described.tone === "success" ? "text-success" : "text-ink-secondary")}>{described.text}</p>
      {changed !== undefined && <Notice title="主机指纹变了" detail={changed} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onTest}>
          {busy ? "测试中…" : "测试连接"}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          删除
        </Button>
      </div>
    </Card>
  );
}

function AddComputerForm({ onCancel, onAdded }: { readonly onCancel: () => void; readonly onAdded: () => void }): ReactNode {
  const [draft, setDraft] = useState<SshDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = (field: DraftField) => (value: string) => setDraft((previous) => ({ ...previous, [field]: value }));

  const submit = async (): Promise<void> => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      await environmentActions.create(environmentRequest(draft));
      onAdded();
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="add-computer-form">
      <h3 className="text-[12px] font-semibold text-ink">添加我的电脑</h3>
      <p className="text-[10px] leading-relaxed text-ink-secondary">
        这里只填写连接信息。密码和私钥都不经过这个页面：连接时由电脑上的环境代理使用它自己的凭据。known-hosts 文件由 EACbot 在自己的数据目录里维护，不需要你指定路径。
      </p>

      <FieldRow id="computer-label" label="名称" error={errors.label} required>
        <Input id="computer-label" value={draft.label} onChange={(event) => set("label")(event.currentTarget.value)} placeholder="办公室机器" />
      </FieldRow>
      <FieldRow id="computer-host" label="主机" error={errors.host} required>
        <Input id="computer-host" value={draft.host} onChange={(event) => set("host")(event.currentTarget.value)} placeholder="box.example.com 或 10.0.0.4" />
      </FieldRow>
      <FieldRow id="computer-port" label="端口" error={errors.port} required>
        <Input
          id="computer-port"
          inputMode="numeric"
          value={draft.port}
          onChange={(event) => set("port")(event.currentTarget.value)}
          className={parsePort(draft.port) === undefined ? "border-danger/60" : undefined}
        />
      </FieldRow>
      <FieldRow id="computer-user" label="账号" error={errors.user} required>
        <Input
          id="computer-user"
          value={draft.user}
          onChange={(event) => set("user")(event.currentTarget.value)}
          placeholder="deploy"
          autoCapitalize="off"
        />
      </FieldRow>
      <FieldRow id="computer-fingerprint" label="主机指纹" error={errors.fingerprint} required>
        <Input
          id="computer-fingerprint"
          value={draft.fingerprint}
          onChange={(event) => set("fingerprint")(event.currentTarget.value)}
          placeholder="SHA256:…"
          autoCapitalize="off"
        />
      </FieldRow>
      <p className="text-[10px] leading-relaxed text-ink-secondary">
        指纹在那台电脑上用 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 可以看到。只有你亲自核对过的指纹才会被固定下来。
      </p>

      {failure !== null && <Notice title="没能保存" detail={failure} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={saving} onClick={() => void submit()}>
          {saving ? "保存中…" : "保存并连接"}
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          取消
        </Button>
      </div>
    </Card>
  );
}

function Notice({ title, detail, onDismiss }: { readonly title: string; readonly detail: string; readonly onDismiss?: () => void }): ReactNode {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-danger">{title}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-ink-secondary">{detail}</p>
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭"
          className="shrink-0 cursor-pointer rounded px-1 text-[11px] text-ink-secondary transition-colors duration-150 hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}

function FieldRow({
  id,
  label,
  error,
  required,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error: string | undefined;
  readonly required?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10px] uppercase tracking-wide text-ink-secondary">
        {label}
        {required === true && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {error !== undefined && <p className="text-[10px] text-danger">{error}</p>}
    </div>
  );
}
