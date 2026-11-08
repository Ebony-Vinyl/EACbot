import { useEffect, useMemo, useState } from "react";
import { Megaphone, TriangleAlert, X } from "lucide-react";

import { activeAnnouncements, type Announcement } from "../../shared/announcement";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

const DISMISSED_KEY = "eacbot.announcements.dismissed";

function dismissedMap(): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, number> : {};
  } catch {
    return {};
  }
}

function forgetDismissed(): void {
  try {
    const kept = Object.fromEntries(Object.entries(dismissedMap()).filter(([, updatedAt]) => updatedAt > Date.now() - 30 * 24 * 3_600_000));
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(kept));
  } catch { /* a full or blocked localStorage keeps every announcement showing */ }
}

/** Dismissing one announcement keeps it hidden until the same id is published again with a newer edit. */
export function dismissedAnnouncement(item: Announcement, dismissed: Record<string, number>): boolean {
  return (dismissed[item.id] ?? -1) >= item.updatedAt;
}

export function AnnouncementsStrip() {
  const { state } = useStore();
  const [dismissed, setDismissed] = useState<Record<string, number>>(dismissedMap);
  // The server filters the window when it serves the list, but a long-lived tab never refetches, so it also
  // re-checks the window every minute on its own.
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const visible = useMemo(
    () => activeAnnouncements(state.announcements ?? [], Date.now()).filter((item) => !dismissedAnnouncement(item, dismissed)),
    // `minute` only paces the re-check; the window itself uses the current time.
    [state.announcements, dismissed, minute],
  );
  if (!visible.length) return null;
  const dismiss = (item: Announcement) => {
    const next = { ...dismissed, [item.id]: item.updatedAt };
    setDismissed(next);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* keep showing next launch */ }
    forgetDismissed();
  };
  return (
    <div data-announcements role="region" aria-label={t("announcements.title")}>
      {visible.map((item) => (
        <div
          key={item.id}
          data-announcement={item.id}
          className={`flex items-start justify-center gap-2 border-b border-hairline/40 px-3 py-1.5 text-[13px] ${item.level === "important" ? "bg-accent/10 text-ink" : "bg-panel text-ink-secondary"}`}
        >
          {item.level === "important"
            ? <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
            : <Megaphone size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}
          <span className="min-w-0 text-center">
            <span className="font-medium text-ink">{item.title}</span>
            {item.body && <span> — {item.body}</span>}
          </span>
          <button
            type="button"
            onClick={() => dismiss(item)}
            aria-label={t("announcements.dismiss")}
            title={t("announcements.dismiss")}
            className="-mr-1 shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
