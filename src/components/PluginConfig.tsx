// Rendering a plugin's configuration from its own schema, and reading its live status. The host decides what a field
// means; this file only decides how it looks, and never holds a secret it was not given.
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, Save, TriangleAlert } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export interface PluginConfigFieldView {
  key: string;
  type: "string" | "number" | "boolean";
  description?: string;
  secret?: boolean;
  enum?: Array<string | number>;
  default?: string | number | boolean;
}

export interface PluginConfigResponse {
  fields: PluginConfigFieldView[];
  values: Record<string, string | number | boolean | { set: true }>;
  missing: string[];
  undeclared: string[];
  restartRequired?: boolean;
}

export interface PluginStatusResponse {
  fields: Array<{ key: string; type: string }>;
  values: Record<string, string | number | boolean>;
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isSetMarker = (value: unknown): value is { set: true } =>
  typeof value === "object" && value !== null && (value as { set?: unknown }).set === true;

/** The value a text box starts with: a secret starts empty, because the server never sends it back. */
function initialText(value: PluginConfigResponse["values"][string] | undefined): string {
  if (value === undefined || isSetMarker(value)) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function PluginConfigForm({ installationId, onSaved }: { installationId: string; onSaved?(): void }) {
  const [config, setConfig] = useState<PluginConfigResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<PluginConfigResponse>(`/api/plugins/${installationId}/config`);
      setConfig(next);
      setDraft(Object.fromEntries(next.fields.map((field) => [field.key, initialText(next.values[field.key])])));
      setError(null);
    } catch (reason) {
      setConfig(null);
      setError(messageOf(reason));
    }
  }, [installationId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!config) return;
    setBusy(true);
    try {
      const submitted: Record<string, unknown> = {};
      for (const field of config.fields) {
        const text = draft[field.key] ?? "";
        if (field.type === "boolean") submitted[field.key] = text === "true";
        else if (field.type === "number") submitted[field.key] = text;
        else submitted[field.key] = text;
      }
      const next = await api<PluginConfigResponse>(`/api/plugins/${installationId}/config`, {
        method: "PUT",
        body: JSON.stringify(submitted),
      });
      setConfig({ ...next, restartRequired: undefined });
      setDraft(Object.fromEntries(next.fields.map((field) => [field.key, initialText(next.values[field.key])])));
      setSaved(true);
      setError(null);
      onSaved?.();
    } catch (reason) {
      setError(messageOf(reason));
      setSaved(false);
    } finally {
      setBusy(false);
    }
  };

  if (error && !config) {
    return <p className="mt-2 flex items-start gap-1.5 text-[12px] text-danger"><TriangleAlert size={13} className="mt-0.5 shrink-0" />{error}</p>;
  }
  if (!config) return <p className="mt-2 text-[12px] text-ink-secondary">{t("extensions.config.loading")}</p>;

  return (
    <PluginConfigFields
      config={config}
      draft={draft}
      onDraft={(next) => { setDraft(next); setSaved(false); }}
      busy={busy}
      saved={saved}
      error={error}
      onSave={() => void save()}
    />
  );
}

/** The form itself, from values already in hand: what a person sees, with no fetching of its own. */
export function PluginConfigFields({
  config, draft, onDraft, busy, saved, error, onSave,
}: {
  config: PluginConfigResponse;
  draft: Record<string, string>;
  onDraft(next: Record<string, string>): void;
  busy: boolean;
  saved: boolean;
  error: string | null;
  onSave(): void;
}) {
  if (!config.fields.length) return <p className="mt-2 text-[12px] text-ink-secondary">{t("extensions.config.none")}</p>;
  const setDraft = onDraft;

  return (
    <div className="mt-2 rounded-xl border border-hairline/35 bg-control/20 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {config.fields.map((field) => {
          const required = config.missing.includes(field.key);
          const set = isSetMarker(config.values[field.key]);
          return (
            <label key={field.key} className={cn("flex min-w-0 flex-col gap-1", field.type === "boolean" ? "" : "sm:col-span-1")}>
              <span className="flex items-center gap-1 text-[12px] font-medium text-ink">
                {field.key}
                {required && <span className="text-danger">*</span>}
                {field.secret && set && <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-normal text-ink-secondary">{t("extensions.config.secretSet")}</span>}
              </span>
              {field.type === "boolean" ? (
                <select
                  value={draft[field.key] ?? "false"}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                  className="h-8 rounded-lg bg-control/70 px-2 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="false">{t("extensions.config.off")}</option>
                  <option value="true">{t("extensions.config.on")}</option>
                </select>
              ) : field.enum ? (
                <select
                  value={draft[field.key] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                  className="h-8 rounded-lg bg-control/70 px-2 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">—</option>
                  {field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
                </select>
              ) : (
                <input
                  value={draft[field.key] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                  placeholder={field.secret && set ? t("extensions.config.secretKept") : field.description ? field.description.slice(0, 60) : ""}
                  inputMode={field.type === "number" ? "decimal" : undefined}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  className="h-8 min-w-0 rounded-lg bg-control/70 px-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              )}
              {field.description && field.type !== "string" && (
                <span className="line-clamp-2 text-[11px] leading-4 text-ink-secondary">{field.description}</span>
              )}
            </label>
          );
        })}
      </div>
      {config.undeclared.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-secondary">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {t("extensions.config.undeclared", { keys: config.undeclared.join(", ") })}
        </p>
      )}
      {error && <p className="mt-2 flex items-start gap-1.5 text-[12px] text-danger"><TriangleAlert size={13} className="mt-0.5 shrink-0" />{error}</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        {saved && <span className="flex items-center gap-1 text-[12px] text-accent"><Check size={13} />{t("extensions.config.saved")}</span>}
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[12px] font-medium text-app disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {t("extensions.config.save")}
        </button>
      </div>
    </div>
  );
}

const STATUS_LABELS: Partial<Record<string, LocaleKey>> = {
  connected: "extensions.status.connected",
  running: "extensions.status.running",
  configured: "extensions.status.configured",
  inboundQueued: "extensions.status.inboundQueued",
  inboundDelivered: "extensions.status.inboundDelivered",
  inboundRefused: "extensions.status.inboundRefused",
  outboundSent: "extensions.status.outboundSent",
  outboundPending: "extensions.status.outboundPending",
  lastError: "extensions.status.lastError",
};

/** What a running plugin says about itself. A stopped or failing plugin says why instead of looking healthy. */
export function PluginStatusLine({ installationId, refreshKey }: { installationId: string; refreshKey?: number }) {
  const [status, setStatus] = useState<PluginStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const answer = await api<{ status: PluginStatusResponse }>(`/api/plugins/${installationId}/status`, { background: true });
      setStatus(answer.status);
    } catch (reason) {
      setStatus({ fields: [], values: {}, error: messageOf(reason) });
    } finally {
      setBusy(false);
    }
  }, [installationId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (!status) return <span className="text-[11px] text-ink-secondary">{busy ? t("extensions.status.loading") : ""}</span>;
  return <PluginStatusReadout status={status} busy={busy} onRefresh={() => void load()} />;
}

/** What a status payload reads as, with no fetching of its own. */
export function PluginStatusReadout({ status, busy, onRefresh }: { status: PluginStatusResponse; busy: boolean; onRefresh(): void }) {
  if (status.error) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-[11px] text-ink-secondary">
        <TriangleAlert size={11} className="shrink-0 text-danger" />
        <span className="truncate">{status.error}</span>
      </span>
    );
  }
  const connected = status.values.connected;
  const tone = connected === true ? "text-accent" : connected === false ? "text-ink-secondary" : "text-ink-secondary";
  const shown = Object.entries(status.values)
    .filter(([key, value]) => key !== "lastError" && value !== "" && value !== 0)
    .slice(0, 6);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-secondary">
      {connected !== undefined && (
        <span className={cn("inline-flex items-center gap-1 font-medium", tone)}>
          <span className={cn("size-1.5 rounded-full", connected === true ? "bg-accent" : "bg-ink-secondary/60")} />
          {t(connected === true ? "extensions.status.connected" : "extensions.status.disconnected")}
        </span>
      )}
      {shown.map(([key, value]) => (
        <span key={key} className="whitespace-nowrap">
          {STATUS_LABELS[key] ? t(STATUS_LABELS[key]!) : key} {String(value)}
        </span>
      ))}
      {typeof status.values.lastError === "string" && status.values.lastError !== "" && (
        <span className="flex min-w-0 items-center gap-1 text-danger">
          <TriangleAlert size={11} className="shrink-0" />
          <span className="truncate">{status.values.lastError}</span>
        </span>
      )}
      <button type="button" onClick={onRefresh} disabled={busy} aria-label={t("extensions.status.refresh")} className="flex size-5 items-center justify-center rounded-full text-ink-secondary hover:bg-raised disabled:opacity-40">
        <RefreshCw size={11} className={cn(busy && "animate-spin")} />
      </button>
    </span>
  );
}
