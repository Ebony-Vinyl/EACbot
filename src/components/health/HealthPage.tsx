import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, HeartPulse, Loader2, Minus, Moon, RefreshCw, Scale, Upload } from "lucide-react";

import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Chip, EmptyState, Field, Input, Notice, PageHeader } from "@/components/ui/field";
import {
  bucketFor, groupedTiles, healthWindow, metricLabel, metricValue, recordLine, seriesSpec, sourceLine, tilesFor, trendArrow,
  type HealthGroup, type HealthTile,
} from "@/lib/health-view";
import type { HealthImportReport, HealthOverview, HealthSample, HealthSource } from "../../../shared/health";

const RANGES = [7, 30, 90, 365] as const;
type Range = (typeof RANGES)[number];

const GROUP_ICON: Record<HealthGroup, typeof Activity> = { activity: Activity, sleep: Moon, heart: HeartPulse, body: Scale, lifestyle: Activity };
const CHART_COLOR = "#1084fe";

/** A metric's line, drawn with the same Vega-Lite config the Data panel uses. */
function MetricChart({ overview, metric }: { overview: HealthOverview; metric: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const series = overview.series.find((entry) => entry.metric === metric);
  const specText = useMemo(() => {
    if (!series || series.points.length < 2) return null;
    return JSON.stringify(seriesSpec(series, { title: metricLabel(metric), color: CHART_COLOR }));
  }, [series, metric]);

  useEffect(() => {
    const element = host.current;
    if (!element || !specText) return;
    let alive = true;
    setFailed(false);
    void (async () => {
      const { default: embed } = await import("vega-embed");
      if (!alive || !element) return;
      element.innerHTML = "";
      try {
        await embed(element, JSON.parse(specText) as never, {
          actions: false,
          renderer: "svg",
          config: { background: "transparent", view: { stroke: null }, axis: { labelColor: "#9aa4b2", titleColor: "#9aa4b2", domain: false }, line: { strokeWidth: 2 } },
        });
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [specText]);

  if (!specText || failed) {
    return <div className="flex h-[160px] items-center justify-center text-[12px] text-ink-secondary">{t("health.chart.empty")}</div>;
  }
  return <div ref={host} className="h-[160px] w-full" />;
}

function Tile({ tile, selected, onSelect }: { tile: HealthTile; selected: boolean; onSelect: () => void }) {
  const Icon = GROUP_ICON[tile.group];
  const direction = trendArrow(tile.trend);
  const Arrow = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : Minus;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors",
        selected ? "border-accent/60 bg-accent/10" : "border-hairline/30 bg-inset hover:border-hairline/60 hover:bg-raised/40",
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{tile.label}</span>
      </span>
      <span className="text-[22px] font-semibold leading-none tabular-nums text-ink">{tile.value}</span>
      <span className="flex items-center gap-1 text-[11px] text-ink-secondary">
        <Arrow size={11} className={cn("shrink-0", direction === "up" ? "text-warning" : direction === "down" ? "text-accent" : "")} />
        <span className="truncate">{tile.trendText}</span>
      </span>
      <span className="text-[10px] text-ink-secondary/70">{t("health.tile.range", { min: tile.min, max: tile.max })}</span>
    </button>
  );
}

export function HealthPage() {
  const [range, setRange] = useState<Range>(30);
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [records, setRecords] = useState<HealthSample[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const window = healthWindow(range);
      const next = await api<HealthOverview>(`/api/health/overview?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}&bucket=${bucketFor(range)}`);
      setOverview(next);
      setError(null);
      setSelected((current) => (current && next.summaries.some((summary) => summary.metric === current) ? current : next.summaries[0]?.metric ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    const window = healthWindow(range);
    void api<{ records: HealthSample[] }>(`/api/health/records?metric=${encodeURIComponent(selected)}&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}&limit=200`)
      .then((next) => setRecords([...next.records].reverse()))
      .catch(() => setRecords([]));
  }, [selected, range]);

  const tiles = useMemo(() => (overview ? tilesFor(overview) : []), [overview]);
  const groups = useMemo(() => groupedTiles(tiles), [tiles]);
  const series = overview?.series.find((entry) => entry.metric === selected) ?? null;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app text-ink">
      <PageHeader title={t("health.title")} subtitle={t("health.subtitle")} className="sticky top-0 z-10 bg-app/95 backdrop-blur">
        <div className="flex items-center gap-1 rounded-lg bg-inset p-0.5">
          {RANGES.map((days) => (
            <Chip key={days} active={range === days} onClick={() => setRange(days)}>{t(`health.range.${days}` as never)}</Chip>
          ))}
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} aria-label={t("health.retry")}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
      </PageHeader>

      <div className="flex flex-col gap-4 p-5">
        {error && <Notice tone="bad">{t("health.error.load", { reason: error })}</Notice>}
        {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

        {loading && !overview ? (
          <div className="flex h-40 items-center justify-center text-ink-secondary"><Loader2 size={18} className="animate-spin" /></div>
        ) : overview && overview.sampleCount === 0 ? (
          <EmptyState title={t("health.empty.title")} body={t("health.empty.body")} />
        ) : (
          <>
            {groups.map(({ group, tiles: groupTiles }) => (
              <section key={group} className="flex flex-col gap-2">
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t(`health.group.${group}` as never)}</h2>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {groupTiles.map((tile) => (
                    <Tile key={tile.metric} tile={tile} selected={selected === tile.metric} onSelect={() => setSelected(tile.metric)} />
                  ))}
                </div>
              </section>
            ))}

            {selected && series && (
              <Card>
                <CardHeader>
                  <CardTitle>{t("health.chart.title", { metric: metricLabel(selected), range: t(`health.range.${range}` as never) })}</CardTitle>
                  <Badge>{t("health.tile.count", { n: series.points.length })}</Badge>
                </CardHeader>
                <CardContent className="pt-1"><MetricChart overview={overview!} metric={selected} /></CardContent>
              </Card>
            )}

            {selected && (
              <Card>
                <CardHeader><CardTitle>{t("health.records.title")}</CardTitle></CardHeader>
                <CardContent className="pt-2">
                  {records.length === 0 ? (
                    <CardDescription>{t("health.records.empty")}</CardDescription>
                  ) : (
                    <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                      {records.map((record) => (
                        <li key={record.sampleId} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-raised/40">
                          <span className="min-w-0 truncate text-ink-secondary">{recordLine(record)}</span>
                          <span className="shrink-0 tabular-nums text-ink">{metricValue(record.value, record.unit)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}

        <AddReading
          onSaved={() => { void load(); setNotice({ tone: "ok", text: t("health.add.saved") }); }}
          onError={(reason) => setNotice({ tone: "bad", text: t("health.add.failed", { reason }) })}
        />
        <ImportPanel
          onDone={(report) => {
            void load();
            setNotice({ tone: "ok", text: `${t("health.import.done", { added: report.added, replaced: report.replaced })}${report.skipped ? ` ${t("health.import.problems", { n: report.skipped })}` : ""}` });
          }}
          onError={(reason) => setNotice({ tone: "bad", text: t("health.import.failed", { reason }) })}
        />
        <CloudPanel onSynced={() => void load()} />
        <SourcesPanel sources={overview?.sources ?? []} onChanged={() => void load()} />

        <p className="px-1 pb-2 text-[11px] leading-relaxed text-ink-secondary/80">{t("health.private")}</p>
      </div>
    </main>
  );
}

function AddReading({ onSaved, onError }: { onSaved: () => void; onError: (reason: string) => void }) {
  const [metric, setMetric] = useState("steps");
  const [value, setValue] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      onError("value must be a number");
      return;
    }
    setBusy(true);
    try {
      await api("/api/health/records", {
        method: "POST",
        body: JSON.stringify({ metric, value: numeric, ...(at ? { at: new Date(at).toISOString() } : {}) }),
      });
      setValue("");
      setAt("");
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>{t("health.add.title")}</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2 pt-2">
        <Field label={t("health.add.metric")}><Input value={metric} onChange={(e) => setMetric(e.target.value)} /></Field>
        <Field label={t("health.add.value")}><Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" className="w-24" /></Field>
        <Field label={t("health.add.when")}><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
        <Button variant="primary" onClick={() => void save()} disabled={busy || !value.trim() || !metric.trim()}>{t("health.add.save")}</Button>
      </CardContent>
    </Card>
  );
}

function ImportPanel({ onDone, onError }: { onDone: (report: HealthImportReport) => void; onError: (reason: string) => void }) {
  const [path, setPath] = useState("");
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!path.trim()) return;
    setRunning(true);
    try {
      const report = await api<HealthImportReport>("/api/health/import", { method: "POST", body: JSON.stringify({ path: path.trim() }), timeoutMs: 120_000 });
      onDone(report);
      setPath("");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-0.5">
        <CardTitle>{t("health.import.title")}</CardTitle>
        <CardDescription>{t("health.import.body")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 pt-2">
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("health.import.path")} className="min-w-0 flex-1" />
        <Button variant="outline" onClick={() => void run()} disabled={running || !path.trim()}>
          <Upload size={13} />
          {running ? t("health.import.running") : t("health.import.run")}
        </Button>
      </CardContent>
    </Card>
  );
}

function SourcesPanel({ sources, onChanged }: { sources: HealthSource[]; onChanged: () => void }) {
  const remove = async (sourceId: string) => {
    if (!window.confirm(t("health.source.removeConfirm", { label: sourceId }))) return;
    try {
      await api("/api/health/records", { method: "DELETE", body: JSON.stringify({ sourceId }) });
      onChanged();
    } catch {}
  };

  return (
    <Card>
      <CardHeader><CardTitle>{t("health.sources.title")}</CardTitle></CardHeader>
      <CardContent className="pt-2">
        {sources.length === 0 ? (
          <CardDescription>{t("health.sources.empty")}</CardDescription>
        ) : (
          <ul className="flex flex-col gap-1">
            {sources.map((source) => (
              <li key={source.sourceId} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Badge tone={source.status === "connected" ? "success" : source.status === "expired" ? "warning" : "danger"}>
                    {t(`health.source.status.${source.status}` as never)}
                  </Badge>
                  <span className="min-w-0 truncate text-ink-secondary">{sourceLine(source)}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => void remove(source.sourceId)}>{t("health.source.remove")}</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface CloudSource {
  sourceId: string;
  provider: string;
  account: string | null;
  lastSyncAt: string | null;
  expiresAt: string | null;
  canRefresh: boolean;
}

/** The cloud half: connect an account, pull what it holds, disconnect. A token never reaches this page. */
function CloudPanel({ onSynced }: { onSynced: () => void }) {
  const [sources, setSources] = useState<CloudSource[]>([]);
  const [providers, setProviders] = useState<Array<{ provider: string; readable: boolean; callbackPath: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [signIn, setSignIn] = useState<{ sourceId: string; url: string; flowId: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<{ sources: CloudSource[]; providers: Array<{ provider: string; readable: boolean; callbackPath: string }> }>("/api/health/cloud");
      setSources(next.sources);
      setProviders(next.providers);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a sign-in is open: the provider answers on its own tab, so this page learns of it here.
  useEffect(() => {
    if (!signIn) return;
    const timer = setInterval(() => {
      void api<{ phase: string; message?: string }>(`/api/health/cloud/status?sourceId=${encodeURIComponent(signIn.sourceId)}`)
        .then((status) => {
          if (status.phase === "succeeded") {
            setSignIn(null);
            setNotice({ tone: "ok", text: t("health.cloud.connected") });
            void load();
            onSynced();
          } else if (status.phase !== "waiting") {
            setSignIn(null);
            setNotice({ tone: "bad", text: status.message ?? t("health.cloud.failed") });
          }
        })
        .catch(() => {});
    }, 1_500);
    return () => clearInterval(timer);
  }, [signIn, load, onSynced]);

  const connect = async (sourceId: string) => {
    setBusy(sourceId);
    try {
      const started = await api<{ sourceId: string; authorizationUrl: string | null; flowId: string }>("/api/health/cloud/connect", {
        method: "POST",
        body: JSON.stringify({ sourceId }),
        timeoutMs: 30_000,
      });
      if (started.authorizationUrl) {
        setSignIn({ sourceId, url: started.authorizationUrl, flowId: started.flowId });
        window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setNotice({ tone: "bad", text: t("health.cloud.connectFailed", { reason: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(null);
    }
  };

  const sync = async (sourceId: string) => {
    setBusy(sourceId);
    try {
      const outcome = await api<{ added: number; replaced: number; skipped: number; error?: { message: string } }>("/api/health/cloud/sync", {
        method: "POST",
        body: JSON.stringify({ sourceId }),
        timeoutMs: 120_000,
      });
      if (outcome.error) setNotice({ tone: "warn", text: outcome.error.message });
      else setNotice({ tone: "ok", text: t("health.cloud.synced", { added: outcome.added, replaced: outcome.replaced }) });
      void load();
      onSynced();
    } catch (e) {
      setNotice({ tone: "bad", text: t("health.cloud.syncFailed", { reason: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (sourceId: string) => {
    if (!window.confirm(t("health.cloud.disconnectConfirm", { label: sourceId }))) return;
    setBusy(sourceId);
    try {
      await api("/api/health/cloud", { method: "DELETE", body: JSON.stringify({ sourceId }) });
      void load();
      onSynced();
    } catch (e) {
      setNotice({ tone: "bad", text: t("health.cloud.disconnectFailed", { reason: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(null);
    }
  };

  const connected = new Set(sources.map((source) => source.provider));
  const readable = providers.filter((provider) => provider.readable);

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-0.5">
        <CardTitle>{t("health.cloud.title")}</CardTitle>
        <CardDescription>{t("health.cloud.body")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-2">
        {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

        {signIn && (
          <Notice tone="warn">
            {t("health.cloud.waiting")}{" "}
            <a href={signIn.url} target="_blank" rel="noreferrer" className="underline">{t("health.cloud.reopen")}</a>
          </Notice>
        )}

        <ul className="flex flex-col gap-1">
          {readable.map((provider) => {
            const source = sources.find((entry) => entry.provider === provider.provider);
            return (
              <li key={provider.provider} className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Badge tone={source ? "success" : "neutral"}>{source ? t("health.cloud.signedIn") : t("health.cloud.notConnected")}</Badge>
                  <span className="truncate capitalize text-ink">{provider.provider}</span>
                  {source?.lastSyncAt && (
                    <span className="shrink-0 text-[11px] text-ink-secondary">{t("health.cloud.lastSync", { when: source.lastSyncAt.slice(0, 16).replace("T", " ") })}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {source ? (
                    <>
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void sync(source.sourceId)}>
                        {busy === source.sourceId ? t("health.cloud.working") : t("health.cloud.sync")}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disconnect(source.sourceId)}>
                        {t("health.cloud.disconnect")}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="primary" disabled={busy !== null || connected.has(provider.provider)} onClick={() => void connect(provider.provider)}>
                      {busy === provider.provider ? t("health.cloud.working") : t("health.cloud.connect")}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        <p className="text-[11px] leading-relaxed text-ink-secondary/80">{t("health.cloud.setup")}</p>
      </CardContent>
    </Card>
  );
}
