import { Library } from "lucide-react";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { GlassBar } from "./GlassScrollFrame";
import { LiveCallPill } from "./LiveCallPill";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarPhoneBar } from "./SidebarPhoneBar";
import { SimpleRailFooter } from "./SidebarSimpleRail";

type FooterProps = Parameters<typeof SidebarFooter>[0] & {
  rail: boolean;
  phone: boolean;
  query: string;
  onQuery(query: string): void;
  currentBotId: string | null;
  onOpenChat(botId: string, threadId: string): void;
  onOpenTasks?: () => void;
};

export function SidebarFooterBar({
  rail,
  phone,
  query,
  onQuery,
  currentBotId,
  onOpenChat,
  onOpenTasks,
  ...footer
}: FooterProps) {
  const owner = useOwnerOrAdmin();
  const iconOnly = footer.density === "icons";
  return (
    <GlassBar edge="bottom">
      {onOpenTasks && owner && (
        <button
          type="button"
          onClick={onOpenTasks}
          aria-label={t("tasks.title")}
          title={t("tasks.title")}
          className="mx-2 mb-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Library size={16} />
          {!iconOnly && t("tasks.title")}
        </button>
      )}
      <LiveCallPill
        currentBotId={currentBotId}
        onOpen={onOpenChat}
        iconOnly={iconOnly}
      />
      {rail ? (
        <SimpleRailFooter owner={footer.owner} archived={footer.archived} />
      ) : phone ? (
        <SidebarPhoneBar query={query} onQuery={onQuery} />
      ) : (
        <SidebarFooter {...footer} />
      )}
    </GlassBar>
  );
}
