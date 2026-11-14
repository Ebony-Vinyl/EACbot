import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Camera, Fan, Lamp, Lightbulb, Loader2, Lock, Play, Plug, Plus, RefreshCw, Thermometer, Tv, WashingMachine, Wind,
} from "lucide-react";

import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/switch-slider";
import { Chip, EmptyState, Field, Input, Notice, PageHeader, SearchInput } from "@/components/ui/field";
import type { HomeAction, HomeDomain, HomeEntity, HomeReceipt, HomeSnapshot } from "../../../shared/home";

const DOMAIN_ICON: Record<HomeDomain, typeof Lamp> = {
  light: Lamp, switch: Lightbulb, plug: Plug, cover: Play, climate: Thermometer, fan: Fan, lock: Lock,
  sensor: Thermometer, binary_sensor: Thermometer, camera: Camera, media_player: Tv, vacuum: WashingMachine,
  scene: Play, script: Play, humidifier: Wind, water_heater: Thermometer, air_purifier: Wind, other: Lightbulb,
};

/** A device's state in the person's words: a raw `on`/`off` becomes "On"/"Off", a sensor keeps its number. */
function stateText(entity: HomeEntity): string {
  if (!entity.available) return t("home.state.unavailable");
  const key = `home.state.${entity.state}` as const;
  const word = t(key as never);
  if (word !== key) return word;
  if (entity.state === "unknown" || entity.state === "") return t("home.state.unknown");
  const unit = typeof entity.attributes.unit_of_measurement === "string" ? entity.attributes.unit_of_measurement : "";
  return unit ? `${entity.state} ${unit}` : entity.state;
}

/** The actions a card offers as buttons: the ones a person presses, not every setter. */
const PRIMARY: ReadonlySet<HomeAction> = new Set(["turn_on", "turn_off", "toggle", "open", "close", "lock", "unlock", "activate", "play", "pause", "stop"]);

function DeviceCard({ entity, onCommand, busy }: { entity: HomeEntity; onCommand: (action: HomeAction, value?: number | string) => void; busy: string | null }) {
  const Icon = DOMAIN_ICON[entity.domain];
  const primary = entity.actions.filter((action) => PRIMARY.has(action));
  const on = entity.state === "on" || entity.state === "open" || entity.state === "playing";
  const brightness = typeof entity.attributes.brightness_pct === "number" ? entity.attributes.brightness_pct : null;
  const temperature = typeof entity.attributes.current_temperature === "number" ? entity.attributes.current_temperature : null;
  const working = busy === entity.entityId;

  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border p-3 transition-colors", entity.available ? "border-hairline/30 bg-inset" : "border-hairline/20 bg-inset/50 opacity-60")}>
      <div className="flex items-start gap-2">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", on ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary")}>
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium leading-tight text-ink">{entity.name}</p>
          <p className="truncate text-[11px] leading-tight text-ink-secondary">
            {stateText(entity)}
            {brightness !== null && entity.state === "on" ? ` · ${brightness}%` : ""}
            {temperature !== null ? ` · ${Math.round(temperature * 10) / 10}°` : ""}
          </p>
        </div>
        {working && <Loader2 size={13} className="shrink-0 animate-spin text-ink-secondary" />}
      </div>

      {primary.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {primary.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={entity.domain === "lock" && (action === "unlock" || action === "open") ? "warning" : "secondary"}
              disabled={working}
              onClick={() => onCommand(action)}
            >
              {t(`home.action.${action}` as never)}
            </Button>
          ))}
        </div>
      )}

      {entity.actions.includes("set_brightness") && entity.state === "on" && (
        <Slider
          min={1}
          max={100}
          step={1}
          defaultValue={[brightness ?? 100]}
          disabled={working}
          onValueCommit={([value]) => onCommand("set_brightness", value!)}
          aria-label={t("home.action.set_brightness")}
        />
      )}
    </div>
  );
}

export function HomePage() {
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zone, setZone] = useState<string | null>(null);
  const [domain, setDomain] = useState<HomeDomain | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<{ entity: HomeEntity; action: HomeAction; value?: number | string } | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const next = await api<HomeSnapshot>(`/api/home${force ? "?refresh=1" : ""}`);
      setSnapshot(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async (entity: HomeEntity, action: HomeAction, value?: number | string, confirm = false) => {
    setBusy(entity.entityId);
    try {
      const { receipt } = await api<{ receipt: HomeReceipt }>("/api/home/commands", {
        method: "POST",
        body: JSON.stringify({ entityId: entity.entityId, action, ...(value === undefined ? {} : { value }), ...(confirm ? { confirm: true } : {}) }),
        timeoutMs: 30_000,
      });
      if (receipt.status === "succeeded") setNotice({ tone: "ok", text: `${entity.name} · ${t("home.receipt.succeeded")}` });
      else if (receipt.status === "indeterminate") setNotice({ tone: "warn", text: t("home.receipt.indeterminate") });
      else setNotice({ tone: "bad", text: t("home.receipt.failed", { reason: receipt.message ?? receipt.code ?? "" }) });
      // Read the state back, so the card shows what the device actually holds.
      void load(true);
    } catch (e) {
      const body = (e as { body?: { error?: { code?: string; message?: string }; needsConfirmation?: boolean } }).body;
      if (body?.error?.code === "sensitive_requires_confirmation" || body?.needsConfirmation) {
        setConfirming({ entity, action, ...(value === undefined ? {} : { value }) });
      } else {
        setNotice({ tone: "bad", text: t("home.receipt.failed", { reason: body?.error?.message ?? (e instanceof Error ? e.message : String(e)) }) });
      }
    } finally {
      setBusy(null);
    }
  }, [load]);

  const entities = useMemo(() => {
    if (!snapshot) return [];
    const needle = query.trim().toLowerCase();
    return snapshot.entities.filter((entity) => {
      if (zone !== null && (entity.zone ?? "") !== zone) return false;
      if (domain && entity.domain !== domain) return false;
      if (needle && !`${entity.name} ${entity.nativeId}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [snapshot, zone, domain, query]);

  const byZone = useMemo(() => {
    const groups = new Map<string, HomeEntity[]>();
    for (const entity of entities) {
      const key = entity.zone ?? "";
      const list = groups.get(key);
      if (list) list.push(entity);
      else groups.set(key, [entity]);
    }
    return [...groups.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
  }, [entities]);

  const domains = useMemo(() => {
    const seen = new Set<HomeDomain>();
    for (const entity of snapshot?.entities ?? []) seen.add(entity.domain);
    return [...seen].sort();
  }, [snapshot]);

  const zoneName = (key: string) => (key ? snapshot?.zones.find((entry) => entry.zone === key)?.name ?? key.replace(/[-_]/g, " ") : t("home.zone.unzoned"));
  const connected = (snapshot?.adapters ?? []).some((adapter) => adapter.status === "ready");
  const canPair = (snapshot?.adapters ?? []).some((adapter) => adapter.kind === "matter");

  const pair = async () => {
    if (!pairCode.trim()) return;
    setPairBusy(true);
    setPairError(null);
    try {
      await api("/api/home/pair", { method: "POST", body: JSON.stringify({ code: pairCode.trim() }), timeoutMs: 200_000 });
      setPairing(false);
      setPairCode("");
      setNotice({ tone: "ok", text: t("home.pair.done") });
      void load(true);
    } catch (e) {
      const body = (e as { body?: { error?: { message?: string } } }).body;
      setPairError(body?.error?.message ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setPairBusy(false);
    }
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <PageHeader
        title={t("home.title")}
        subtitle={snapshot ? `${t("home.subtitle")} · ${t("home.adapters.count", { n: snapshot.entities.length })}` : t("home.subtitle")}
      >
        <Button variant="ghost" size="icon" onClick={() => void load(true)} disabled={loading} aria-label={t("home.refresh")}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </Button>
        {canPair && (
          <Button variant="outline" size="sm" onClick={() => setPairing(true)}>
            <Plus size={13} />
            {t("home.pair.title")}
          </Button>
        )}
      </PageHeader>

      {connected && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline/30 px-5 py-2">
          <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("home.search")} className="w-40" />
          <Chip active={zone === null} onClick={() => setZone(null)}>{t("home.zone.all")}</Chip>
          {(snapshot?.zones ?? []).map((entry) => (
            <Chip key={entry.zone} active={zone === entry.zone} onClick={() => setZone(entry.zone)}>{entry.name}</Chip>
          ))}
          {domains.length > 1 && (
            <>
              <span className="mx-1 h-3 w-px bg-hairline/40" />
              <Chip active={domain === null} onClick={() => setDomain(null)}>{t("home.domain.all")}</Chip>
              {domains.map((entry) => (
                <Chip key={entry} active={domain === entry} onClick={() => setDomain(entry)}>{t(`home.domain.${entry}` as never)}</Chip>
              ))}
            </>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        {error && <Notice tone="bad">{t("home.error.load", { reason: error })}</Notice>}
        {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

        {loading && !snapshot ? (
          <div className="flex h-40 items-center justify-center text-ink-secondary"><Loader2 size={18} className="animate-spin" /></div>
        ) : !snapshot || snapshot.adapters.length === 0 ? (
          <EmptyState title={t("home.empty.title")} body={t("home.empty.body")} />
        ) : entities.length === 0 ? (
          <p className="px-1 text-[12px] text-ink-secondary">{t("home.empty.filtered")}</p>
        ) : (
          byZone.map(([key, rows]) => (
            <section key={key || "unzoned"} className="flex flex-col gap-2">
              <h2 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{zoneName(key)}</h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {rows.map((entity) => (
                  <DeviceCard key={entity.entityId} entity={entity} busy={busy} onCommand={(action, value) => void send(entity, action, value)} />
                ))}
              </div>
            </section>
          ))
        )}

        {(snapshot?.adapters.length ?? 0) > 0 && (
          <Card>
            <CardHeader><CardTitle>{t("home.adapters.title")}</CardTitle></CardHeader>
            <CardContent className="pt-2">
              <ul className="flex flex-col gap-1">
                {snapshot!.adapters.map((adapter) => (
                  <li key={adapter.adapterId} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Badge tone={adapter.status === "ready" ? "success" : adapter.status === "unauthorized" ? "warning" : "danger"}>
                        {t(`home.adapters.${adapter.status}` as never)}
                      </Badge>
                      <span className="truncate text-ink">{adapter.label}</span>
                      {!adapter.controllable && <span className="shrink-0 text-[10px] text-ink-secondary">· {t("home.adapters.readOnly")}</span>}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-secondary">{t("home.adapters.count", { n: adapter.entityCount })}</span>
                  </li>
                ))}
              </ul>
              {snapshot!.adapters.some((adapter) => adapter.statusReason) && (
                <CardDescription className="mt-1.5 truncate">{snapshot!.adapters.find((adapter) => adapter.statusReason)?.statusReason}</CardDescription>
              )}
            </CardContent>
          </Card>
        )}

        <p className="px-1 pb-2 text-[11px] leading-relaxed text-ink-secondary/80">{t("home.private")}</p>
      </div>

      <Dialog open={pairing} onOpenChange={(open) => { if (!open && !pairBusy) { setPairing(false); setPairError(null); } }}>
        {pairing && (
          <DialogContent>
            <DialogTitle>{t("home.pair.title")}</DialogTitle>
            <DialogDescription>{t("home.pair.body")}</DialogDescription>
            <div className="mt-3 flex flex-col gap-2">
              <Field label={t("home.pair.code")}>
                <Input
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  placeholder="3497-011-2332"
                  autoFocus
                  disabled={pairBusy}
                  onKeyDown={(e) => { if (e.key === "Enter") void pair(); }}
                />
              </Field>
              {pairError && <Notice tone="bad">{t("home.pair.failed", { reason: pairError })}</Notice>}
              {pairBusy && <p className="text-[11px] text-ink-secondary">{t("home.pair.waiting")}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={pairBusy} onClick={() => setPairing(false)}>{t("home.confirm.no")}</Button>
              <Button variant="primary" disabled={pairBusy || !pairCode.trim()} onClick={() => void pair()}>
                {pairBusy ? t("home.pair.working") : t("home.pair.start")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        {confirming && (
          <DialogContent>
            <DialogTitle>{t("home.confirm.title")}</DialogTitle>
            <DialogDescription>
              {t("home.confirm.body", { action: t(`home.action.${confirming.action}` as never), name: confirming.entity.name })}
            </DialogDescription>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(null)}>{t("home.confirm.no")}</Button>
              <Button
                variant="warning"
                onClick={() => {
                  const pending = confirming;
                  setConfirming(null);
                  void send(pending.entity, pending.action, pending.value, true);
                }}
              >
                {t("home.confirm.yes", { action: t(`home.action.${confirming.action}` as never) })}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}

export { stateText };
