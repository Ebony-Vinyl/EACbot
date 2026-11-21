import { useEffect, useState } from "react";

import { t } from "@/lib/music/ports";
import { MaskIcon, WindowGlyph } from "./SurfaceIcons";

export function SurfaceTitleBar({ query, onQueryChange, onSearch, onBack, onOpenSettings }: {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: (value: string) => void;
  onBack: () => void;
  onOpenSettings: () => void;
}) {
  const controls = window.ogb?.windowControls;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let alive = true;
    void controls.state().then(({ maximized: value }) => { if (alive) setMaximized(value); });
    return controls.onMaximizedChanged(setMaximized);
  }, [controls]);

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  return (
    <div className="m-titlebar">
      <button type="button" className="m-back" onClick={onBack}>
        <WindowGlyph name="chevronLeft" size={13} />
        {t("music.back")}
      </button>

      <form
        className="m-search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(query);
        }}
      >
        <WindowGlyph name="search" size={12} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("music.searchPlaceholder")}
          aria-label={t("music.searchPlaceholder")}
        />
      </form>

      <button type="button" className="m-winbtn" onClick={onOpenSettings} title={t("music.settings")}>
        <MaskIcon src="/music/gear-svgrepo-com.svg" size={18} />
      </button>
      <button type="button" className="m-winbtn" onClick={fullscreen} title={t("browser.panel.fullscreen")}>
        <WindowGlyph name="fullscreen" size={12} />
      </button>
      <button type="button" className="m-winbtn m-winbtn--minimize" onClick={() => void controls?.minimize()} title={t("window.minimize")}>
        <WindowGlyph name="minimize" size={12} />
      </button>
      <button type="button" className="m-winbtn" onClick={() => void controls?.toggleMaximize()} title={t("window.maximize")}>
        <WindowGlyph name={maximized ? "restore" : "maximize"} size={12} />
      </button>
      <button type="button" className="m-winbtn m-winbtn--close" onClick={() => void controls?.close()} title={t("common.close")}>
        <WindowGlyph name="close" size={12} />
      </button>
    </div>
  );
}
