import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, ShieldCheck, Trash2, Users, X } from "lucide-react";

import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import { PLATFORM_LABELS } from "@/lib/platforms";
import type { PlatformId, PlatformStatus } from "../../shared/plugins/accounts.ts";

interface Account {
  accountId: string;
  platform: PlatformId;
  externalAccountId: string;
  displayName: string;
  status: PlatformStatus;
  capabilities: string[];
}

interface MemorySpace {
  spaceId: string;
  name: string;
  audience: "owner" | "shared";
  revision: number;
  epoch: number;
  members: Array<{ botId: string; access: "read" | "read-write" }>;
}

const PLATFORMS = Object.keys(PLATFORM_LABELS) as PlatformId[];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Connects platform accounts and manages shared-memory membership; nothing here runs a platform turn. */
export function PlatformAccountsPanel({ onClose }: { onClose(): void }) {
  const { state } = useStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState({ platform: "qq" as PlatformId, externalAccountId: "", displayName: "" });
  const [bindChoice, setBindChoice] = useState<Record<string, string>>({});
  const [ownerId, setOwnerId] = useState<Record<string, string>>({});
  const [spaceForm, setSpaceForm] = useState({ spaceId: "", name: "", audience: "shared" as "owner" | "shared" });
  const [memberChoice, setMemberChoice] = useState<Record<string, { botId: string; access: "read" | "read-write" }>>({});

  const load = useCallback(async () => {
    try {
      const [accountAnswer, spaceAnswer] = await Promise.all([
        api<{ accounts: Account[] }>("/api/platforms/accounts", { background: true }),
        api<{ spaces: MemorySpace[] }>("/api/memory-spaces", { background: true }),
      ]);
      setAccounts(accountAnswer.accounts);
      setSpaces(spaceAnswer.spaces);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await load();
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  };

  const addAccount = () => mutate("account:add", async () => {
    await api("/api/platforms/accounts", { method: "POST", body: JSON.stringify(accountForm) });
    setAccountForm({ platform: "qq", externalAccountId: "", displayName: "" });
  });

  const bind = (account: Account) => {
    const choice = bindChoice[account.accountId] ?? "";
    if (!choice) return;
    return mutate(`bind:${account.accountId}`, () => api(`/api/platforms/accounts/${account.accountId}/bind`, {
      method: "POST",
      body: JSON.stringify(choice === "new"
        ? { mode: "dedicated", name: `${account.displayName} (${PLATFORM_LABELS[account.platform]})` }
        : { mode: "existing", botId: choice }),
    }));
  };

  const saveOwner = (account: Account) => {
    const externalPersonId = ownerId[account.accountId]?.trim();
    if (!externalPersonId) return;
    return mutate(`owner:${account.accountId}`, () => api(`/api/platforms/accounts/${account.accountId}/identities`, {
      method: "POST",
      body: JSON.stringify({ externalPersonId, personId: "owner", role: "owner" }),
    }));
  };

  const addSpace = () => mutate("space:add", async () => {
    await api("/api/memory-spaces", { method: "POST", body: JSON.stringify(spaceForm) });
    setSpaceForm({ spaceId: "", name: "", audience: "shared" });
  });

  const addMember = (space: MemorySpace) => {
    const choice = memberChoice[space.spaceId];
    if (!choice?.botId) return;
    return mutate(`member:${space.spaceId}`, () => api(`/api/memory-spaces/${space.spaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ ...choice, revision: space.revision }),
    }));
  };

  const field = "h-9 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink outline-none focus:border-accent";
  const pill = "inline-flex h-8 items-center gap-1.5 rounded-full bg-control px-3 text-[12px] font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-50";

  return (
    <div className="glass-popup-frame" style={glassPopupFrameStyle()} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex max-h-[80vh] w-[min(860px,94vw)] flex-col overflow-hidden rounded-[22px] bg-panel text-ink shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Users size={18} />
            <h2 className="text-[16px] font-semibold">{t("platforms.title")}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("platforms.close")}>
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p>}
          {loading ? <p className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("platforms.loading")}</p> : (
            <>
              <section>
                <h3 className="mb-2 text-[14px] font-semibold">{t("platforms.accounts")}</h3>
                <div className="mb-3 flex flex-wrap items-end gap-2">
                  <select className={cn(field, "w-28")} value={accountForm.platform} onChange={(event) => setAccountForm({ ...accountForm, platform: event.target.value as PlatformId })}>
                    {PLATFORMS.map((platform) => <option key={platform} value={platform}>{PLATFORM_LABELS[platform]}</option>)}
                  </select>
                  <input className={cn(field, "w-44")} placeholder={t("platforms.externalId")} value={accountForm.externalAccountId} onChange={(event) => setAccountForm({ ...accountForm, externalAccountId: event.target.value })} />
                  <input className={cn(field, "w-44")} placeholder={t("platforms.displayName")} value={accountForm.displayName} onChange={(event) => setAccountForm({ ...accountForm, displayName: event.target.value })} />
                  <button type="button" className={pill} disabled={busy !== null || !accountForm.externalAccountId || !accountForm.displayName} onClick={() => void addAccount()}>
                    <Plus size={14} />{t("platforms.addAccount")}
                  </button>
                </div>
                {accounts.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("platforms.emptyAccounts")}</p> : (
                  <ul className="space-y-2">
                    {accounts.map((account) => (
                      <li key={account.accountId} className="rounded-xl border border-line p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold">{PLATFORM_LABELS[account.platform]}</span>
                          <span className="font-medium">{account.displayName}</span>
                          <span className="text-ink-secondary">{account.externalAccountId} · {account.status}</span>
                          <span className="ml-auto flex flex-wrap items-center gap-2">
                            <select className={cn(field, "h-8 w-40")} value={bindChoice[account.accountId] ?? ""} onChange={(event) => setBindChoice({ ...bindChoice, [account.accountId]: event.target.value })}>
                              <option value="">{t("platforms.chooseBot")}</option>
                              <option value="new">{t("platforms.createDedicated")}</option>
                              {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                            </select>
                            <button type="button" className={pill} disabled={busy !== null || !bindChoice[account.accountId]} onClick={() => void bind(account)}>{t("platforms.bind")}</button>
                            <button type="button" className={pill} disabled={busy !== null} onClick={() => void mutate(`unbind:${account.accountId}`, () => api(`/api/platforms/accounts/${account.accountId}/bind`, { method: "DELETE" }))}>{t("platforms.unbind")}</button>
                            <button type="button" className={cn(pill, "text-danger")} disabled={busy !== null} onClick={() => void mutate(`remove:${account.accountId}`, () => api(`/api/platforms/accounts/${account.accountId}`, { method: "DELETE" }))}><Trash2 size={14} /></button>
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input className={cn(field, "h-8 w-56")} placeholder={t("platforms.ownerExternalId")} value={ownerId[account.accountId] ?? ""} onChange={(event) => setOwnerId({ ...ownerId, [account.accountId]: event.target.value })} />
                          <button type="button" className={pill} disabled={busy !== null || !ownerId[account.accountId]?.trim()} onClick={() => void saveOwner(account)}><ShieldCheck size={14} />{t("platforms.saveOwner")}</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="mt-6">
                <h3 className="mb-2 text-[14px] font-semibold">{t("platforms.spaces")}</h3>
                <div className="mb-3 flex flex-wrap items-end gap-2">
                  <input className={cn(field, "w-32")} placeholder={t("platforms.spaceId")} value={spaceForm.spaceId} onChange={(event) => setSpaceForm({ ...spaceForm, spaceId: event.target.value })} />
                  <input className={cn(field, "w-44")} placeholder={t("platforms.spaceName")} value={spaceForm.name} onChange={(event) => setSpaceForm({ ...spaceForm, name: event.target.value })} />
                  <select className={cn(field, "w-32")} value={spaceForm.audience} onChange={(event) => setSpaceForm({ ...spaceForm, audience: event.target.value as "owner" | "shared" })}>
                    <option value="shared">{t("platforms.audience.shared")}</option>
                    <option value="owner">{t("platforms.audience.owner")}</option>
                  </select>
                  <button type="button" className={pill} disabled={busy !== null || !spaceForm.spaceId || !spaceForm.name} onClick={() => void addSpace()}><Plus size={14} />{t("platforms.addSpace")}</button>
                </div>
                {spaces.length === 0 ? <p className="text-[13px] text-ink-secondary">{t("platforms.emptySpaces")}</p> : (
                  <ul className="space-y-2">
                    {spaces.map((space) => (
                      <li key={space.spaceId} className="rounded-xl border border-line p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="font-medium">{space.name}</span>
                          <span className="text-ink-secondary">{space.spaceId} · {t(`platforms.audience.${space.audience}`)} · r{space.revision} · e{space.epoch}</span>
                          <button type="button" className={cn(pill, "ml-auto")} disabled={busy !== null} onClick={() => void mutate(`revoke:${space.spaceId}`, () => api(`/api/memory-spaces/${space.spaceId}/revoke`, { method: "POST", body: JSON.stringify({ revision: space.revision }) }))}>{t("platforms.revoke")}</button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {space.members.length === 0 ? <span className="text-[12px] text-ink-secondary">{t("platforms.noMembers")}</span> : space.members.map((member) => (
                            <span key={member.botId} className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[12px]">
                              {state.bots.find((bot) => bot.id === member.botId)?.name ?? member.botId} · {member.access}
                              <button type="button" className="text-ink-secondary hover:text-danger" disabled={busy !== null} aria-label={t("platforms.removeMember")} onClick={() => void mutate(`member-remove:${space.spaceId}`, () => api(`/api/memory-spaces/${space.spaceId}/members/${member.botId}?revision=${space.revision}`, { method: "DELETE" }))}><X size={12} /></button>
                            </span>
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <select className={cn(field, "h-8 w-40")} value={memberChoice[space.spaceId]?.botId ?? ""} onChange={(event) => setMemberChoice({ ...memberChoice, [space.spaceId]: { botId: event.target.value, access: memberChoice[space.spaceId]?.access ?? "read" } })}>
                            <option value="">{t("platforms.chooseBot")}</option>
                            {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                          </select>
                          <select className={cn(field, "h-8 w-32")} value={memberChoice[space.spaceId]?.access ?? "read"} onChange={(event) => setMemberChoice({ ...memberChoice, [space.spaceId]: { botId: memberChoice[space.spaceId]?.botId ?? "", access: event.target.value as "read" | "read-write" } })}>
                            <option value="read">{t("platforms.readOnly")}</option>
                            <option value="read-write">{t("platforms.readWrite")}</option>
                          </select>
                          <button type="button" className={pill} disabled={busy !== null || !memberChoice[space.spaceId]?.botId} onClick={() => void addMember(space)}><Plus size={14} />{t("platforms.addMember")}</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
