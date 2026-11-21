import nativeText from "./native-text.cjs";

// Retain the Windows notification-area identity across app restarts.
export function createSystemTray({ Tray, Menu, nativeImage, iconPath, getWindow, onQuit, onMusicCommand, t = nativeText.englishText.t }) {
  const tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }),
    "889af657-21b5-4ec9-b5d0-cb798cbdfd30");
  let hidden = false;
  const show = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    hidden = false;
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  };
  /** What the player is doing, when the renderer has told this process about it. */
  let musicState = null;
  const musicMenu = () => {
    if (!musicState) return [];
    const send = (command) => () => onMusicCommand?.(command);
    return [
      { label: `${musicState.playing ? "⏸" : "▶"}  ${musicState.title || "Music"}`.trim(), enabled: false },
      ...(musicState.artists ? [{ label: `    ${musicState.artists}`, enabled: false }] : []),
      {
        label: musicState.playing ? t("native.tray.musicPause") : t("native.tray.musicPlay"),
        click: send("play-pause"),
      },
      { label: t("native.tray.musicNext"), click: send("next") },
      { label: t("native.tray.musicPrevious"), click: send("previous") },
      { type: "separator" },
    ];
  };
  const label = () => tray.setContextMenu(Menu.buildFromTemplate([
    ...musicMenu(),
    { label: t("native.tray.open"), click: show },
    { type: "separator" },
    { label: t("native.tray.quit"), click: onQuit },
  ]));
  tray.setToolTip("EACbot Bot");
  label();
  tray.on("click", show);
  tray.on("double-click", show);
  return {
    show,
    hide(win) { hidden = true; win.setSkipTaskbar(true); win.hide(); },
    isHidden() { return hidden; },
    windowShown(win) { hidden = false; win.setSkipTaskbar(false); },
    relabel() { if (!tray.isDestroyed()) label(); },
    /** The renderer's now-playing state; null clears the music section. */
    setMusic(state) {
      musicState = state && typeof state.title === "string" ? state : null;
      if (!tray.isDestroyed()) label();
    },
    destroy() { if (!tray.isDestroyed()) tray.destroy(); },
  };
}
