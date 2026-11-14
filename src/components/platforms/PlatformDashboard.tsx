// The board for whichever platform is open. A platform with a board of its own gets it; every other platform is
// drawn from the shared contract, so a new platform works the moment its plugin answers `board`.
import type { PlatformId } from "../../../shared/plugins/accounts";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { XianyuBoard } from "./XianyuBoard";
import { TiebaBoard } from "./TiebaBoard";
import { ContentDeskBoard } from "./ContentDeskBoard";
import { GenericBoard } from "./GenericBoard";

const OWN_BOARD: Partial<Record<PlatformId, (props: { onBack(): void }) => React.ReactNode>> = {
  xianyu: XianyuBoard,
  tieba: TiebaBoard,
  xiaohongshu: ({ onBack }) => <ContentDeskBoard platform="xiaohongshu" title="小红书" onBack={onBack} />,
  douyin: ({ onBack }) => <ContentDeskBoard platform="douyin" title="抖音" onBack={onBack} />,
};

export function PlatformDashboard({ platform, onBack }: { platform: PlatformId; onBack(): void }) {
  const Own = OWN_BOARD[platform];
  if (Own) return <>{Own({ onBack })}</>;
  return <GenericBoard platform={platform} title={PLATFORM_LABELS[platform] ?? platform} onBack={onBack} />;
}
