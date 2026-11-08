import { useCallback, useEffect, useState } from "react";
import { Download, KeyRound, Loader2, Package, Play, Plus, Power, RefreshCw, RotateCcw, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";

import { api } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { PluginGrants } from "./PluginGrants";

interface MarketEntry {
  pluginId: string;
  version: string;
  title: string;
  summary?: string;
  sourceId: string;
  trust: "official" | "reviewed" | "community";
  revoked: { reason: string } | null;
  installed: { installationId: string; version: string; state: string } | null;
  artifacts: Array<{ platform: string }>;
}

interface Channel {
  sourceId: string;
  name: string;
  url: string;
  keyId: string;
  trust: string;
  enabled: boolean;
  sequence: number;
  lastFetchedAt?: string;
  lastError?: string;
}

interface InstalledPlugin {
  installationId: string;
  pluginId: string;
  version: string;
  sourceId: string;
  state: string;
  runtime: { mode: string };
  permissions: Array<{ id: string; capability: string; effect: string }>;
}

const STATE_KEYS: Record<string, LocaleKey> = {
  active: "extensions.state.active",
  disabled: "extensions.state.disabled",
  "installed-disabled": "extensions.state.installedDisabled",
};

const stateLabel = (state: string) => (STATE_KEYS[state] ? t(STATE_KEYS[state]) : state);

interface CatalogResponse {
  entries: MarketEntry[];
  channels: Channel[];
}

const TRUST_KEYS = {
  official: "extensions.trust.official",
  reviewed: "extensions.trust.reviewed",
  community: "extensions.trust.community",
} as const;

const trustLabel = (trust: MarketEntry["trust"]) => t(TRUST_KEYS[trust]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ExtensionsCatalog({ onClose }: { onClose(): void }) {
  const { state } = useStore();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [grantsFor, setGrantsFor] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [channel, setChannel] = useState({ sourceId: "", name: "", url: "", keyId: "", publicKeyPem: "" });

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const [catalog, installed] = await Promise.all([
        api<CatalogResponse>(`/api/plugins/catalog${refresh ? "?refresh=1" : ""}`, { background: !refresh }),
        api<{ plugins: InstalledPlugin[] }>("/api/plugins", { background: !refresh }),
      ]);
      setCatalog(catalog);
      setInstalled(installed.plugins);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const mutate = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await load(true);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  };

  const addChannel = () => mutate("channel:add", async () => {
    await api("/api/plugins/channels", { method: "POST", body: JSON.stringify(channel) });
    setChannel({ sourceId: "", name: "", url: "", keyId: "", publicKeyPem: "" });
    setShowChannelForm(false);
  });

  const install = (entry: MarketEntry) => mutate(`install:${entry.pluginId}@${entry.version}`, () =>
    api("/api/plugins/install", {
      method: "POST",
      body: JSON.stringify({ sourceId: entry.sourceId, pluginId: entry.pluginId, version: entry.version }),
    }));

  const update = (entry: MarketEntry) => mutate(`update:${entry.installed?.installationId}`, () =>
    api(`/api/plugins/${entry.installed!.installationId}/update`, { method: "POST", body: JSON.stringify({ version: entry.version }) }));

  const rollback = (entry: MarketEntry) => mutate(`rollback:${entry.installed?.installationId}`, () =>
    api(`/api/plugins/${entry.installed!.installationId}/rollback`, { method: "POST" }));

  const setEnabled = (installationId: string, verb: "activate" | "disable") => mutate(`state:${installationId}`, () =>
    api(`/api/plugins/${installationId}/${verb}`, { method: "POST" }));

  const uninstall = (installationId: string) => mutate(`remove:${installationId}`, () =>
    api(`/api/plugins/${installationId}`, { method: "DELETE" }));

  const installLocal = () => {
    if (!localPath.trim()) return;
    void mutate("local", async () => {
      await api("/api/plugins/local", { method: "POST", body: JSON.stringify({ path: localPath.trim() }) });
      setLocalPath("");
    });
  };

  const removeChannel = (sourceId: string) => mutate(`channel:${sourceId}`, () =>
    api(`/api/plugins/channels/${encodeURIComponent(sourceId)}`, { method: "DELETE" }));

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="extensions-title"
        className="glass-surface glass-popup animate-pop-in relative flex max-h-[86vh] max-w-[980px] flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div className="min-w-0">
            <h2 id="extensions-title" className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("extensions.title")}</h2>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("extensions.subtitle")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label={t("extensions.refresh")}
              title={t("extensions.refresh")}
            >
              <RefreshCw size={16} className={cn(loading && "animate-spin")} />
            </button>
            <button type="button" onClick={onClose} aria-label={t("extensions.close")} className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-7">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          <section className="mb-7">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[14px] font-semibold text-ink">{t("extensions.channels")}</h3>
                <p className="text-[12px] text-ink-secondary">{t("extensions.channelsHint")}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowChannelForm((open) => !open)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-control/70 px-3 text-[13px] font-medium text-ink hover:bg-raised"
              >
                <Plus size={14} /> {t("extensions.addChannel")}
              </button>
            </div>

            {showChannelForm && (
              <div className="mb-3 grid gap-2 rounded-xl border border-hairline/40 bg-control/30 p-3 sm:grid-cols-2">
                <input value={channel.sourceId} onChange={(event) => setChannel({ ...channel, sourceId: event.target.value })} placeholder={t("extensions.sourceId")} className="h-9 rounded-lg bg-control/70 px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                <input value={channel.name} onChange={(event) => setChannel({ ...channel, name: event.target.value })} placeholder={t("extensions.sourceName")} className="h-9 rounded-lg bg-control/70 px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                <input value={channel.url} onChange={(event) => setChannel({ ...channel, url: event.target.value })} placeholder="https://…/catalog.json" className="h-9 rounded-lg bg-control/70 px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent sm:col-span-2" />
                <input value={channel.keyId} onChange={(event) => setChannel({ ...channel, keyId: event.target.value })} placeholder={t("extensions.keyId")} className="h-9 rounded-lg bg-control/70 px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
                <div className="text-[12px] leading-9 text-ink-secondary">{t("extensions.communityTrustHint")}</div>
                <textarea value={channel.publicKeyPem} onChange={(event) => setChannel({ ...channel, publicKeyPem: event.target.value })} placeholder={t("extensions.publicKey")} rows={4} className="min-h-24 rounded-lg bg-control/70 px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent sm:col-span-2" />
                <div className="flex justify-end sm:col-span-2">
                  <button type="button" disabled={busy === "channel:add"} onClick={addChannel} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-medium text-app disabled:opacity-50">
                    {busy === "channel:add" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t("extensions.add")}
                  </button>
                </div>
              </div>
            )}

            <div className="grid gap-2">
              {(catalog?.channels ?? []).map((source) => (
                <div key={source.sourceId} className="flex items-center gap-3 rounded-xl border border-hairline/35 bg-control/25 px-3 py-2">
                  <ShieldCheck size={15} className="shrink-0 text-ink-secondary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{source.name} <span className="font-normal text-ink-secondary">· {source.sourceId}</span></div>
                    <div className="truncate text-[12px] text-ink-secondary">{source.url} · {source.trust} · #{source.sequence}{source.lastError ? ` · ${source.lastError}` : ""}</div>
                  </div>
                  <button type="button" onClick={() => removeChannel(source.sourceId)} disabled={busy === `channel:${source.sourceId}`} className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50" aria-label={t("extensions.removeChannel")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {!catalog?.channels.length && <div className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">{t("extensions.noChannels")}</div>}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h3 className="text-[14px] font-semibold text-ink">{t("extensions.catalog")}</h3>
                <p className="text-[12px] text-ink-secondary">{t("extensions.catalogHint")}</p>
              </div>
              {loading && <Loader2 size={15} className="animate-spin text-ink-secondary" />}
            </div>

            <div className="grid gap-2 @container sm:grid-cols-2">
              {(catalog?.entries ?? []).map((entry) => {
                const key = `${entry.pluginId}@${entry.version}`;
                const same = entry.installed?.version === entry.version;
                return (
                  <div key={`${entry.sourceId}:${key}`} className="flex min-w-0 flex-col rounded-xl border border-hairline/35 bg-control/25 p-3">
                    <div className="flex items-start gap-2">
                      <Package size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-ink">{entry.title}</div>
                        <div className="truncate text-[12px] text-ink-secondary">{entry.pluginId} · {entry.version}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-secondary">{trustLabel(entry.trust)}</span>
                    </div>
                    {entry.summary && <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-ink-secondary">{entry.summary}</p>}
                    {entry.revoked && <p className="mt-2 flex items-start gap-1 text-[12px] text-danger"><TriangleAlert size={13} className="mt-0.5 shrink-0" />{entry.revoked.reason}</p>}
                    <div className="mt-auto flex items-center justify-end gap-1.5 pt-3">
                      {entry.installed && (
                        <button type="button" onClick={() => rollback(entry)} disabled={Boolean(entry.revoked) || busy === `rollback:${entry.installed.installationId}`} className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-40">
                          <RotateCcw size={13} /> {t("extensions.rollback")}
                        </button>
                      )}
                      {same && entry.installed ? (
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex h-7 items-center rounded-full bg-raised px-2.5 text-[12px] text-ink-secondary">{stateLabel(entry.installed.state)}</span>
                          {entry.installed.state === "active" ? (
                            <button type="button" onClick={() => setEnabled(entry.installed!.installationId, "disable")} disabled={busy === `state:${entry.installed!.installationId}`} className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-40">
                              {busy === `state:${entry.installed.installationId}` ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} {t("extensions.disable")}
                            </button>
                          ) : (
                            <button type="button" onClick={() => setEnabled(entry.installed!.installationId, "activate")} disabled={busy === `state:${entry.installed!.installationId}`} className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-2.5 text-[12px] font-medium text-app disabled:opacity-40">
                              {busy === `state:${entry.installed.installationId}` ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {t("extensions.enable")}
                            </button>
                          )}
                        </div>
                      ) : entry.installed ? (
                        <button type="button" onClick={() => update(entry)} disabled={Boolean(entry.revoked) || busy === `update:${entry.installed.installationId}`} className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-2.5 text-[12px] font-medium text-app disabled:opacity-40">
                          {busy === `update:${entry.installed.installationId}` ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {t("extensions.update")}
                        </button>
                      ) : (
                        <button type="button" onClick={() => install(entry)} disabled={Boolean(entry.revoked) || busy === `install:${key}`} className="inline-flex h-7 items-center gap-1 rounded-full bg-ink px-2.5 text-[12px] font-medium text-app disabled:opacity-40">
                          {busy === `install:${key}` ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {t("extensions.install")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {!loading && !catalog?.entries.length && <div className="rounded-xl border border-dashed border-hairline/40 px-3 py-8 text-center text-[13px] text-ink-secondary">{t("extensions.emptyCatalog")}</div>}
          </section>

          <section className="mt-7 border-t border-hairline/30 pt-5">
            <h3 className="text-[14px] font-semibold text-ink">{t("extensions.installedTitle")}</h3>
            <p className="mt-0.5 text-[12px] text-ink-secondary">{t("extensions.installedHint")}</p>
            <div className="mt-2 grid gap-2">
              {installed.map((plugin) => (
                <div key={plugin.installationId} className="rounded-xl border border-hairline/35 bg-control/25 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <Package size={15} className="shrink-0 text-ink-secondary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">{plugin.pluginId} <span className="font-normal text-ink-secondary">&middot; {plugin.version}</span></div>
                      <div className="truncate text-[12px] text-ink-secondary">{plugin.installationId} &middot; {plugin.sourceId} &middot; {plugin.permissions.length > 0 ? t("extensions.permissions", { count: plugin.permissions.length }) : t("extensions.noPermissions")}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${plugin.state === "active" ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary"}`}>{stateLabel(plugin.state)}</span>
                    <button
                      type="button"
                      onClick={() => setGrantsFor((current) => (current === plugin.installationId ? null : plugin.installationId))}
                      aria-expanded={grantsFor === plugin.installationId}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      <KeyRound size={13} /> {t("extensions.grants.button")}
                    </button>
                    {plugin.state === "active" ? (
                      <button type="button" onClick={() => setEnabled(plugin.installationId, "disable")} disabled={busy === `state:${plugin.installationId}`} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-40">
                        {busy === `state:${plugin.installationId}` ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} {t("extensions.disable")}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setEnabled(plugin.installationId, "activate")} disabled={busy === `state:${plugin.installationId}`} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink px-2.5 text-[12px] font-medium text-app disabled:opacity-40">
                        {busy === `state:${plugin.installationId}` ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {t("extensions.enable")}
                      </button>
                    )}
                    <button type="button" onClick={() => uninstall(plugin.installationId)} disabled={busy === `remove:${plugin.installationId}`} aria-label={t("extensions.uninstall")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {grantsFor === plugin.installationId && (
                    <PluginGrants installationId={plugin.installationId} bots={state.bots.filter((bot) => !bot.hidden).map((bot) => ({ id: bot.id, name: bot.name }))} />
                  )}
                </div>
              ))}
              {!installed.length && <div className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">{t("extensions.installedEmpty")}</div>}
            </div>
          </section>

          <section className="mt-7 border-t border-hairline/30 pt-5">
            <h3 className="text-[14px] font-semibold text-ink">{t("extensions.localTitle")}</h3>
            <p className="mt-0.5 text-[12px] text-ink-secondary">{t("extensions.localHint")}</p>
            <div className="mt-2 flex gap-2">
              <input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder={t("extensions.localPath")} className="h-9 min-w-0 flex-1 rounded-lg bg-control/70 px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
              <button type="button" onClick={installLocal} disabled={!localPath.trim() || busy === "local"} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-control/70 px-3 text-[13px] font-medium text-ink hover:bg-raised disabled:opacity-40">
                {busy === "local" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t("extensions.installLocal")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
