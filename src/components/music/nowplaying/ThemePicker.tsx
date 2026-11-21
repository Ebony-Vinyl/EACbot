// The theme picker upstream opens from the now-playing layer: the six presets, each
// drawn as a miniature of its own backdrop so the choice reads before it is made.
import type { NowPlayingTheme } from "../../../../shared/music.ts";
import { NOW_PLAYING_THEMES } from "../../../../shared/music.ts";
import { cn } from "@/lib/music/ports";
import { t } from "@/lib/music/ports";
import { THEME_LABELS, themeSkin } from "@/lib/music/theme";

/** A miniature of a theme: its background, its glass, and its lyric line. */
function ThemeSwatch({ theme }: { theme: NowPlayingTheme }) {
  const skin = themeSkin(theme);
  return (
    <span className="relative block h-[52px] w-full overflow-hidden rounded-lg" style={{ background: skin.background }} aria-hidden="true">
      <span className="absolute inset-x-2 top-2 h-1.5 rounded-full" style={{ background: skin.lyricActive, opacity: 0.85 }} />
      <span className="absolute inset-x-4 top-[18px] h-1 rounded-full" style={{ background: skin.lyricIdle }} />
      <span className="absolute inset-x-2 bottom-1.5 h-4 rounded" style={{ background: skin.glass, border: `1px solid ${skin.glassBorder}` }} />
      <span className="absolute bottom-3 left-3 size-1.5 rounded-full" style={{ background: skin.accent }} />
    </span>
  );
}

export function ThemePicker({ current, onPick }: {
  current: NowPlayingTheme;
  onPick: (theme: NowPlayingTheme) => void;
}) {
  return (
    <div className="w-[260px] rounded-2xl p-3" style={{ background: "var(--np-glass)", border: "1px solid var(--np-glass-border)", boxShadow: "var(--np-glass-shadow)", backdropFilter: "blur(18px)" }}>
      <p className="mb-2 text-[11px] font-medium" style={{ color: "var(--np-lyric-active)" }}>{t("music.theme")}</p>
      <div className="grid grid-cols-2 gap-2">
        {NOW_PLAYING_THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            onClick={() => onPick(theme)}
            className={cn("flex flex-col gap-1 rounded-xl p-1 text-left transition-colors")}
            style={{ border: `1px solid ${current === theme ? "var(--np-accent)" : "transparent"}` }}
            aria-pressed={current === theme}
          >
            <ThemeSwatch theme={theme} />
            <span className="px-0.5 text-[10px]" style={{ color: current === theme ? "var(--np-accent)" : "var(--np-lyric-idle)" }}>{THEME_LABELS[theme]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
