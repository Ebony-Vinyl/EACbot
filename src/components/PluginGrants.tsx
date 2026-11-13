import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { PluginGrantTarget } from "../../shared/plugins/permissions";

interface PluginTool {
  id: string;
  effect: string;
  description?: string;
  permission: string;
}

interface PluginGrant {
  grantId: string;
  toolless?: never;
  botId: string;
  principalId: string;
  audienceId: string;
  permissionId: string;
  effect: string;
  createdAt: string;
  expiresAt?: string;
  epoch: number;
  maxUses?: number;
  uses: number;
}

const EFFECT_TONES: Record<string, string> = {
  read: "bg-raised text-ink-secondary",
  draft: "bg-raised text-ink-secondary",
  send: "bg-accent/15 text-accent",
  write: "bg-accent/15 text-accent",
  control: "bg-warn/15 text-warn",
  delete: "bg-danger/15 text-danger",
  financial: "bg-danger/15 text-danger",
  security: "bg-danger/15 text-danger",
};

export function PluginGrants({ installationId, bots }: { installationId: string; bots: Array<{ id: string; name: string }> }) {
  const [tools, setTools] = useState<PluginTool[] | null>(null);
  const [grants, setGrants] = useState<PluginGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [targets, setTargets] = useState<PluginGrantTarget[]>([]);
  const [form, setForm] = useState({ toolId: "", botId: "", target: "", maxUses: "", days: "" });

  const load = useCallback(async () => {
    try {
      const [toolList, grantList, targetList] = await Promise.all([
        api<{ tools: PluginTool[] }>(`/api/plugins/${installationId}/tools`),
        api<{ grants: PluginGrant[] }>(`/api/plugins/${installationId}/grants`),
        api<{ targets: PluginGrantTarget[] }>("/api/plugins/grant-targets"),
      ]);
      setTools(toolList.tools);
      setGrants(grantList.grants);
      setTargets(targetList.targets);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [installationId]);

  useEffect(() => { void load(); }, [load]);

  const issue = async () => {
    const botId = form.botId || bots[0]?.id;
    const toolId = form.toolId || tools?.[0]?.id;
    if (!botId || !toolId) return;
    const target = targets.find((candidate) => candidate.botId === botId && candidate.audienceId + "\n" + candidate.principalId === form.target);
    if (form.target && !target) return;
    setBusy("issue");
    try {
      const maxUses = Number(form.maxUses) > 0 ? Number(form.maxUses) : undefined;
      const days = Number(form.days) > 0 ? Number(form.days) : undefined;
      await api(`/api/plugins/${installationId}/grants`, {
        method: "POST",
        body: JSON.stringify({
          toolId,
          botId,
          principalId: target?.principalId ?? `bot:${botId}`,
          audienceId: target?.audienceId ?? `bot:${botId}`,
          ...(target ? { resources: { accounts: [target.accountId] } } : {}),
          epoch: 0,
          ...(maxUses ? { maxUses } : {}),
          ...(days ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
        }),
      });
      setForm({ toolId: "", botId: "", target: "", maxUses: "", days: "" });
      await load();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(`revoke:${grantId}`);
    try {
      await api(`/api/plugins/${installationId}/grants/${grantId}`, { method: "DELETE" });
      await load();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const grantTone = (effect: string) => EFFECT_TONES[effect] ?? "bg-raised text-ink-secondary";
  const botName = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? botId;

  return (
    <div className="mt-2 rounded-xl border border-hairline/40 bg-control/20 p-3" data-plugin-grants={installationId}>
      <div className="flex items-center gap-2">
        <KeyRound size={14} className="shrink-0 text-ink-secondary" />
        <h4 className="text-[13px] font-semibold text-ink">{t("extensions.grants.title")}</h4>
        <p className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">{t("extensions.grants.hint")}</p>
      </div>

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      <div className="mt-2 grid gap-1.5">
        {(tools ?? []).map((tool) => {
          const covered = (grants ?? []).filter((grant) => grant.permissionId === tool.permission);
          return (
            <div key={tool.id} className="flex items-center gap-2 rounded-lg bg-control/30 px-2.5 py-1.5">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${grantTone(tool.effect)}`}>{tool.effect}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{tool.id}</span>
              <span className="shrink-0 text-[11px] text-ink-secondary">
                {tool.effect === "read" || tool.effect === "draft"
                  ? t("extensions.grants.auto")
                  : covered.length
                    ? t("extensions.grants.covered", { count: covered.length })
                    : t("extensions.grants.uncovered")}
              </span>
            </div>
          );
        })}
        {!tools && <Loader2 size={14} className="mx-auto animate-spin text-ink-secondary" />}
        {tools?.length === 0 && <p className="text-[12px] text-ink-secondary">{t("extensions.grants.noTools")}</p>}
      </div>

      {(grants ?? []).length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {(grants ?? []).map((grant) => (
            <div key={grant.grantId} className="flex items-center gap-2 rounded-lg bg-control/30 px-2.5 py-1.5">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${grantTone(grant.effect)}`}>{grant.effect}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                {botName(grant.botId)}
                <span className="text-ink-secondary"> · {grant.audienceId} · {grant.principalId}</span>
                <span className="text-ink-secondary"> · {grant.grantId.slice(0, 18)} · {grant.uses}{grant.maxUses ? `/${grant.maxUses}` : ""}{grant.expiresAt ? ` · ${t("extensions.grants.until", { date: grant.expiresAt.slice(0, 10) })}` : ""}</span>
              </span>
              <button
                type="button"
                onClick={() => void revoke(grant.grantId)}
                disabled={busy === `revoke:${grant.grantId}`}
                aria-label={t("extensions.grants.revoke")}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
              >
                {busy === `revoke:${grant.grantId}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {tools && tools.length > 0 && bots.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select value={form.toolId} onChange={(event) => setForm({ ...form, toolId: event.target.value })} aria-label={t("extensions.grants.tool")} className="h-8 min-w-0 flex-1 rounded-lg bg-control/70 px-2 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="">{t("extensions.grants.pickTool")}</option>
            {tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.id} ({tool.effect})</option>)}
          </select>
          <select value={form.botId} onChange={(event) => setForm({ ...form, botId: event.target.value, target: "" })} aria-label={t("extensions.grants.bot")} className="h-8 min-w-0 flex-1 rounded-lg bg-control/70 px-2 text-[12px] text-ink focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="">{t("extensions.grants.pickBot")}</option>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
          <select
            value={form.target}
            onChange={(event) => setForm({ ...form, target: event.target.value })}
            aria-label={t("extensions.grants.audience")}
            className="h-8 min-w-0 max-w-full flex-1 rounded-lg bg-control/70 px-2 text-[12px] text-ink"
          >
            <option value="">{t("extensions.grants.localAudience")}</option>
            {targets.filter((target) => target.botId === (form.botId || bots[0]?.id)).map((target) => (
              <option key={target.audienceId + target.principalId} value={target.audienceId + "\n" + target.principalId}>{target.label}</option>
            ))}
          </select>
          <input value={form.days} onChange={(event) => setForm({ ...form, days: event.target.value.replace(/[^\d]/g, "") })} placeholder={t("extensions.grants.days")} aria-label={t("extensions.grants.days")} className="h-8 w-16 rounded-lg bg-control/70 px-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
          <button
            type="button"
            onClick={() => void issue()}
            disabled={busy === "issue" || !(form.toolId || (tools ?? []).length)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3 text-[12px] font-medium text-app disabled:opacity-40"
          >
            {busy === "issue" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} {t("extensions.grants.issue")}
          </button>
        </div>
      )}
    </div>
  );
}
