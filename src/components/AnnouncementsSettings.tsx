import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

import type { Announcement, AnnouncementLevel } from "../../shared/announcement";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

type Draft = { title: string; body: string; level: AnnouncementLevel; startsAt: string; endsAt: string; editing: string | null };

const emptyDraft: Draft = { title: "", body: "", level: "info", startsAt: "", endsAt: "", editing: null };

const toInput = (ms?: number) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
const fromInput = (value: string) => (value ? new Date(value).getTime() : null);

const field = "w-full rounded-lg bg-control/70 px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AnnouncementsSettings() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await api<{ announcements: Announcement[] }>("/api/announcements/manage");
      setItems(answer.announcements);
      setError(null);
    } catch (reason) {
      setItems([]);
      setError(messageOf(reason));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft || !draft.title.trim() || busy) return;
    setBusy(true);
    try {
      const body = JSON.stringify({
        title: draft.title.trim(), body: draft.body, level: draft.level,
        startsAt: fromInput(draft.startsAt), endsAt: fromInput(draft.endsAt),
      });
      await api(draft.editing ? `/api/announcements/${encodeURIComponent(draft.editing)}` : "/api/announcements", { method: draft.editing ? "PATCH" : "POST", body });
      setDraft(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/announcements/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const edit = (item: Announcement) => setDraft({
    title: item.title, body: item.body, level: item.level,
    startsAt: toInput(item.startsAt), endsAt: toInput(item.endsAt), editing: item.id,
  });

  return (
    <div data-announcements-settings className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-secondary">{t("announcements.manage.hint")}</p>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink">{items === null ? "…" : t("announcements.manage.count", { count: items.length })}</span>
        {!draft && (
          <button type="button" className="ui-button" onClick={() => setDraft({ ...emptyDraft })}>
            <span className="inline-flex items-center gap-1.5"><Plus size={13} /> {t("announcements.manage.add")}</span>
          </button>
        )}
      </div>

      {draft && (
        <div className="flex flex-col gap-2 rounded-xl border border-hairline/40 bg-control/25 p-3">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder={t("announcements.manage.titleField")} maxLength={200} className={field} />
          <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder={t("announcements.manage.bodyField")} maxLength={4_000} rows={3} className={field} />
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
              {t("announcements.manage.level")}
              <select value={draft.level} onChange={(event) => setDraft({ ...draft, level: event.target.value as AnnouncementLevel })} className={field}>
                <option value="info">{t("announcements.manage.levelInfo")}</option>
                <option value="important">{t("announcements.manage.levelImportant")}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
              {t("announcements.manage.startsAt")}
              <input type="datetime-local" value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
              {t("announcements.manage.endsAt")}
              <input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} className={field} />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="ui-button" onClick={() => setDraft(null)}><span className="inline-flex items-center gap-1.5"><X size={13} /> {t("common.cancel")}</span></button>
            <button type="button" className="ui-button" disabled={!draft.title.trim() || busy} onClick={() => void save()}>
              <span className="inline-flex items-center gap-1.5">{busy ? <Loader2 size={13} className="animate-spin" /> : null} {t("common.save")}</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {(items ?? []).map((item) => (
          <div key={item.id} className="flex items-start gap-3 rounded-xl border border-hairline/35 bg-control/25 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">
                {item.title}
                <span className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${item.level === "important" ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary"}`}>
                  {t(item.level === "important" ? "announcements.manage.levelImportant" : "announcements.manage.levelInfo")}
                </span>
              </div>
              {item.body && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{item.body}</p>}
              <p className="mt-0.5 text-[11px] text-ink-secondary">
                {item.startsAt ? t("announcements.manage.window", { from: toInput(item.startsAt).replace("T", " "), to: item.endsAt ? toInput(item.endsAt).replace("T", " ") : "∞" }) : t("announcements.manage.always")}
              </p>
            </div>
            <button type="button" onClick={() => edit(item)} disabled={Boolean(draft)} aria-label={t("announcements.manage.edit")} title={t("announcements.manage.edit")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">
              <Pencil size={13} />
            </button>
            <button type="button" onClick={() => void remove(item.id)} disabled={busy} aria-label={t("announcements.manage.delete")} title={t("announcements.manage.delete")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {items !== null && !items.length && !draft && <div className="rounded-xl border border-dashed border-hairline/40 px-3 py-4 text-[13px] text-ink-secondary">{t("announcements.manage.empty")}</div>}
      </div>
    </div>
  );
}
