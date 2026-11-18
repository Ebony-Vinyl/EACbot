import { Fragment, useState } from "react";
import { Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { keySaved } from "@/lib/product-events";
import { addedServers } from "@/lib/openai-compat-endpoints";
import { cn } from "@/lib/cn";
import { KEY_FIELD } from "./keys/KeyRow";
import { Select } from "./Select";

export function modelIds(text: string): string[] {
  return [...new Set(text.split(/[,，、\s]+/).map((id) => id.trim()).filter(Boolean))];
}

const INPUT = cn(KEY_FIELD, "font-sans");
/** A slow computer can take minutes before a local model's first words, so the wait is the person's call. */
export const REPLY_WAIT_CHOICES = [5, 10, 20, 30, 60] as const;
const ICON_BUTTON = "ui-icon-button shrink-0 hover:text-ink";
/** Google's Gemini API speaks the OpenAI protocol here; the key comes from Google AI Studio. */
export const GEMINI_PRESET = { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" } as const;

const saveReplyWait = (instanceId: string, minutes: number | null): Promise<{ instances?: unknown }> =>
  api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "PATCH", body: JSON.stringify({ replyWaitMinutes: minutes }) });

function ReplyWaitSelect({ server, disabled, onPick }: { server: InstanceInfo; disabled: boolean; onPick: (minutes: number | null) => void }) {
  return (
    <Select
      size="sm"
      className="shrink-0"
      value={server.replyWaitMinutes ?? ""}
      onChange={(event) => onPick(event.target.value ? Number(event.target.value) : null)}
      disabled={disabled}
      aria-label={t("apiInstances.replyWaitFor", { name: server.displayName })}
      title={t("apiInstances.replyWaitHint")}
    >
      <option value="">{t("apiInstances.replyWaitDefault")}</option>
      {[...new Set([...REPLY_WAIT_CHOICES, ...(server.replyWaitMinutes ? [server.replyWaitMinutes] : [])])].sort((a, b) => a - b).map((minutes) => (
        <option key={minutes} value={minutes}>{t("apiInstances.replyWaitMinutes", { minutes: String(minutes) })}</option>
      ))}
    </Select>
  );
}

/** The built-in server whose base URL is set above, often a local Ollama: the same wait as an added server. */
export function BuiltInReplyWait() {
  const { state, dispatch, refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = state.instances.find((instance) => instance.instanceId === "openaiCompat" && instance.driverKind === "openai-compat");
  if (!server || !state.config?.openaiCompat?.url) return null;
  const pick = (minutes: number | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void saveReplyWait(server.instanceId, minutes)
      .then(async ({ instances }) => {
        if (Array.isArray(instances)) dispatch({ type: "instances", instances: instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
      })
      .catch((e: Error) => setError(e.message || t("apiInstances.failed")))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-1">
      <ReplyWaitSelect server={server} disabled={busy} onPick={pick} />
      <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.replyWaitHint")}</p>
      {error && <div role="alert" className="text-[12px] leading-4 text-danger">{error}</div>}
    </div>
  );
}

export function OtherOpenAiCompatServers() {
  const { state } = useStore();
  return <AddedServers servers={addedServers(state.instances)} />;
}

function AddedServers({ servers }: { servers: Array<InstanceInfo & { url?: string; managedModels?: string[] }> }) {
  const { dispatch, refreshInstances } = useStore();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState<"add" | "other" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; name: string; url: string; key: string; models: string; available?: string[] } | null>(null);
  const ready = Boolean(name.trim() && url.trim() && key.trim());

  const run = (kind: "add" | "other", request: () => Promise<{ instances?: unknown }>, onDone?: () => void) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    void request()
      .then(async ({ instances }) => {
        if (Array.isArray(instances)) dispatch({ type: "instances", instances: instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
        onDone?.();
      })
      .catch((e: Error) => setError(e.message || t("apiInstances.failed")))
      .finally(() => setBusy(null));
  };

  const add = () => ready && run(
    "add",
    () => api("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({ displayName: name.trim(), url: url.trim(), key: key.trim(), ...(modelIds(models).length ? { models: modelIds(models) } : {}) }),
    }).then(
      (added) => { keySaved("custom_endpoint", "settings", "unverified"); return added; },
      (cause: unknown) => { keySaved("custom_endpoint", "settings", "error"); throw cause; },
    ),
    () => { setName(""); setUrl(""); setKey(""); setModels(""); },
  );

  return (
    <div data-api-keys-other>
      <div className="mb-0.5 text-[13px] leading-[18px] text-ink">{t("apiInstances.title")}</div>
      <p className="mb-2 text-[12px] leading-4 text-ink-secondary">{t("apiInstances.subtitle")}</p>
      {servers.length === 0 && <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.empty")}</p>}
      {servers.map((server) => (
        <Fragment key={server.instanceId}><div className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5">
          <button type="button" className="min-w-0 flex-1 text-left" disabled={busy !== null}
            aria-expanded={edit?.id === server.instanceId}
            onClick={() => setEdit(edit?.id === server.instanceId ? null : {
              id: server.instanceId, name: server.displayName, url: server.url ?? "", key: "", models: (server.managedModels ?? []).join(", "),
            })}>
            <span className="block truncate text-[12px] text-ink">{server.displayName} · {t("claudeEndpoints.edit")} ▾</span>
            <span className="block truncate font-mono text-[11px] text-ink-secondary">{server.url}</span>
          </button>
          <ReplyWaitSelect
            server={server}
            disabled={busy !== null}
            onPick={(minutes) => run("other", () => saveReplyWait(server.instanceId, minutes))}
          />
          <button
            type="button"
            onClick={() => run("other", () => api(`/api/instances/${encodeURIComponent(server.instanceId)}/refresh-models`, { method: "POST" }))}
            disabled={busy !== null}
            aria-label={t("apiInstances.refreshModels", { name: server.displayName })}
            title={t("apiInstances.refreshModels", { name: server.displayName })}
            className="ui-button shrink-0"
          >
            <RotateCw size={13} aria-hidden="true" /> {t("model.refreshTitle")}
          </button>
          <button
            type="button"
            onClick={() => run("other", () => api(`/api/instances/${encodeURIComponent(server.instanceId)}`, { method: "DELETE" }))}
            disabled={busy !== null}
            aria-label={t("apiInstances.remove", { name: server.displayName })}
            title={t("apiInstances.remove", { name: server.displayName })}
            className={`${ICON_BUTTON} hover:bg-danger/10 hover:text-danger`}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
        {edit?.id === server.instanceId && <form className="mb-3 grid gap-2 rounded-lg border border-hairline p-3" onSubmit={(event) => {
          event.preventDefault();
          run("other", () => api(`/api/instances/${encodeURIComponent(edit.id)}`, { method: "PATCH", body: JSON.stringify({ endpoint: {
            displayName: edit.name.trim(), url: edit.url.trim(), ...(edit.key.trim() ? { key: edit.key.trim() } : {}), models: modelIds(edit.models),
          } }) }), () => setEdit(null));
        }}>
          {(["name", "url", "key", "models"] as const).map((field) => <label key={field} className="grid gap-1 text-xs">
            {t(`apiInstances.${field}`)}
            <input className={INPUT} type={field === "key" ? "password" : field === "url" ? "url" : "text"}
              required={field === "name" || field === "url"} disabled={busy !== null} autoComplete="off"
              placeholder={field === "key" ? "留空保留现有密钥" : undefined}
              value={edit[field]} onChange={(event) => setEdit({ ...edit, [field]: event.target.value })}/>
          </label>)}
          <button className="ui-button self-start" type="button" disabled={busy !== null || edit.url.trim() !== server.url || Boolean(edit.key.trim())}
            title="使用已保存的地址和密钥拉取模型。更换连接信息后请先保存。"
            onClick={async () => {
              setBusy("other");
              setError(null);
              try {
                const { models } = await api<{ models: string[] }>(`/api/instances/${encodeURIComponent(edit.id)}/pull-models`, { method: "POST" });
                setEdit(current => current?.id === edit.id ? { ...current, available: models } : current);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "拉取失败");
              } finally { setBusy(null); }
            }}>拉取模型列表</button>
          {edit.available && <fieldset className="max-h-48 overflow-y-auto rounded border border-hairline p-2">
            <legend>已拉取 {edit.available.length} 个模型，勾选后保存</legend>
            {edit.available.map(id => <label key={id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={modelIds(edit.models).includes(id)} onChange={event => {
                const selected = modelIds(edit.models).filter(model => model !== id);
                if (event.target.checked) selected.push(id);
                setEdit({ ...edit, models: selected.join(", ") });
              }}/>{id}
            </label>)}
          </fieldset>}
          <div className="flex gap-2"><button className="ui-button" disabled={busy !== null}>{t("common.save")}</button>
            <button type="button" className="ui-button" disabled={busy !== null} onClick={() => setEdit(null)}>{t("common.cancel")}</button></div>
        </form>}
        </Fragment>
      ))}
      <div className="mt-2 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => { setName(GEMINI_PRESET.name); setUrl(GEMINI_PRESET.url); }}
          disabled={busy !== null}
          className="ui-button self-start"
        >
          {t("apiInstances.geminiPreset")}
        </button>
        {url.trim() === GEMINI_PRESET.url && <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.geminiKeyHint")}</p>}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("apiInstances.name")} aria-label={t("apiInstances.name")}
          spellCheck={false} disabled={busy !== null} className={INPUT} />
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1" aria-label={t("apiInstances.url")}
          spellCheck={false} disabled={busy !== null} className={cn(INPUT, "font-mono")} />
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("apiInstances.key")} aria-label={t("apiInstances.key")}
          autoComplete="off" disabled={busy !== null} className={cn(INPUT, "font-mono")} />
        <input value={models} onChange={(e) => setModels(e.target.value)} placeholder={t("apiInstances.models")} aria-label={t("apiInstances.models")}
          spellCheck={false} disabled={busy !== null} className={cn(INPUT, "font-mono")} />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.modelsHint")}</p>
        <button
          type="button"
          onClick={add}
          disabled={busy !== null || !ready}
          className="ui-button self-start"
        >
          {busy === "add" ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
          {busy === "add" ? t("apiInstances.adding") : t("apiInstances.add")}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export const LM_STUDIO_PLACEHOLDER_KEY = "lm-studio";

export function lmStudioBaseUrl(port: string): string | null {
  const text = port.trim();
  if (!/^[1-9]\d{0,4}$/.test(text)) return null;
  const value = Number(text);
  if (value > 65535) return null;
  return `http://127.0.0.1:${value}/v1`;
}

export function LmStudioServer({ heading = true }: { heading?: boolean } = {}) {
  const { state, dispatch, refreshInstances } = useStore();
  const added = addedServers(state.instances);
  const [port, setPort] = useState("1234");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = lmStudioBaseUrl(port);
  const present = Boolean(url && added.some((server) => server.url === url));

  const add = () => {
    if (busy || !url || present) return;
    setBusy(true);
    setError(null);
    void api("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({
        displayName: "LM Studio",
        url,
        key: token.trim() || LM_STUDIO_PLACEHOLDER_KEY,
        catalog: "lmstudio",
      }),
    }).then(
      async (created) => {
        keySaved("custom_endpoint", "settings", "unverified");
        if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
        setToken("");
      },
      (cause: unknown) => {
        keySaved("custom_endpoint", "settings", "error");
        setError(cause instanceof Error && cause.message ? cause.message : t("apiInstances.failed"));
      },
    ).finally(() => setBusy(false));
  };

  return (
    <div className={cn(heading && "rounded-lg border border-hairline/40 bg-inset px-3 py-2")}>
      {heading && <div className="text-[13px] text-ink">{t("lmStudio.title")}</div>}
      <p className={cn("text-[12px] leading-4 text-ink-secondary", heading && "mt-1")}>{t("lmStudio.desc")}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        <label className="flex flex-col gap-1 text-[12px] leading-4 text-ink-secondary">
          {t("lmStudio.port")}
          <input
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            aria-label={t("lmStudio.port")}
            spellCheck={false}
            disabled={busy}
            className={cn(INPUT, "font-mono")}
          />
        </label>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={t("lmStudio.token")}
          aria-label={t("lmStudio.token")}
          autoComplete="off"
          disabled={busy}
          className={cn(INPUT, "font-mono")}
        />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("lmStudio.tokenHint")}</p>
        {url && <p className="truncate font-mono text-[12px] leading-4 text-ink-secondary">{url}</p>}
        <button
          type="button"
          onClick={add}
          disabled={busy || !url || present}
          className="ui-button self-start"
        >
          {busy ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
          {busy ? t("lmStudio.adding") : t("lmStudio.add")}
        </button>
        {present && <p className="text-[12px] text-ink-secondary">{t("lmStudio.added")}</p>}
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
