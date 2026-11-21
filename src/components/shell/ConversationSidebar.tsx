import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { useShellView } from "@/lib/shell-view";

export function ConversationSidebar({ mobile, open, onClose, children }: {
  mobile: boolean;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useShellView();
  const previousView = useRef(view);
  useLayoutEffect(() => {
    const changed = previousView.current !== view;
    previousView.current = view;
    const panel = element.current;
    if (changed && mobile && open && panel && document.activeElement === document.body) {
      panel.querySelector<HTMLElement>('[data-shell-surface] [data-segment][aria-selected="true"]')?.focus({ preventScroll: true });
    }
  }, [view, mobile, open]);
  useEffect(() => {
    if (!mobile || !open) return;
    const panel = element.current;
    if (!panel) return;
    const previous = document.activeElement;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")]
      .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && !item.closest('[inert], [hidden], [aria-hidden="true"]') && item.getClientRects().length > 0);
    (focusable()[0] ?? panel).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== "Tab") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-conversation-drawer])')) return;
      const controls = focusable();
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const active = document.activeElement;
      if ((active === document.body || panel.contains(active)) && previous instanceof HTMLElement && previous.isConnected
        && !previous.closest("[inert], [hidden]")) previous.focus({ preventScroll: true });
    };
  }, [mobile, open]);
  return (
    <div ref={element} className="workspace-conversation-list" data-conversation-drawer={mobile && open ? "" : undefined}
      role={mobile && open ? "dialog" : undefined} aria-modal={mobile && open ? true : undefined}
      aria-label={t("sidebar.aria")} aria-hidden={mobile && !open ? true : undefined} tabIndex={-1}
      inert={mobile && !open} onKeyDown={(event) => {
        if (!mobile || !open || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return;
        const layers = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
        if ([...layers].some((layer) => layer !== event.currentTarget && !layer.closest('[hidden], [inert], [aria-hidden="true"]')
          && getComputedStyle(layer).display !== "none" && getComputedStyle(layer).visibility !== "hidden")) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}>
      {children}
    </div>
  );
}
