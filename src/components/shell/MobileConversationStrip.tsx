import { IconUsersGroup } from "@tabler/icons-react";
import { BotAvatar } from "@/components/Avatar";
import { botUnreadCount } from "@/lib/bot-unread";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { useStore } from "@/state/store";
import { openBotRow } from "@/state/thread-navigation";

export function MobileConversationStrip({ onSelect }: { onSelect?: () => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const selectedId = state.activeView === "chat" ? state.selectedId : null;
  const bots = state.bots.filter((bot) => !bot.hidden);
  if (!bots.length && !state.groups.length) return <span className="workspace-mobile-title">{t("neutral.chat")}</span>;

  return (
    <nav className="workspace-mobile-conversations" aria-label={t("sidebar.aria")}>
      {bots.map((bot) => (
        <button type="button" key={bot.id} data-mobile-conversation={bot.id} aria-current={selectedId === bot.id ? "true" : undefined}
          data-unread={botUnreadCount(bot) > 0 || undefined} onClick={() => {
            openBotRow(dispatch, bot, showThreads, selectedId === bot.id);
            onSelect?.();
          }}>
          <span aria-hidden="true"><BotAvatar bot={bot} size={34} animated={false} /></span>
          <span className="sr-only">{bot.name}</span>
        </button>
      ))}
      {state.groups.map((group) => (
        <button type="button" key={group.id} data-mobile-conversation={group.id} aria-current={selectedId === group.id ? "true" : undefined}
          data-unread={group.unread || undefined} onClick={() => {
            dispatch({ type: "select", id: group.id });
            onSelect?.();
          }}>
          <IconUsersGroup size={22} aria-hidden="true" /><span className="sr-only">{group.name}</span>
        </button>
      ))}
    </nav>
  );
}
