import type { PlatformId } from "../../shared/plugins/accounts.ts";

/** How each platform is named in the interface; the wire keeps the stable id. */
export const PLATFORM_LABELS: Readonly<Record<PlatformId, string>> = {
  qq: "QQ",
  bilibili: "B站",
  xianyu: "闲鱼",
  douyin: "抖音",
  xiaohongshu: "小红书",
  tieba: "贴吧",
};
