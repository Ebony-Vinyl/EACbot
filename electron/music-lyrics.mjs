// The desktop lyric window: a click-through, always-on-top strip that shows the
// line being sung and the next one. It is a plain data-URL page driven entirely by
// IPC, so it has no access to the app's renderer, and it remembers where the person
// put it.
import { fileURLToPath } from "node:url";

export const MUSIC_LYRICS_WINDOW = Object.freeze({
  width: 900,
  height: 132,
  /** Above the taskbar and over full-screen apps, the tier a karaoke overlay uses. */
  level: "screen-saver",
  /** How far the window may drift from the work area before it is pulled back on screen. */
  edge: 40,
});

/** Where the strip sits on first use: centred, a little above the bottom edge. */
export function lyricsBounds(workArea, size = { width: MUSIC_LYRICS_WINDOW.width, height: MUSIC_LYRICS_WINDOW.height }) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - Math.round(workArea.height * 0.12)),
    width,
    height,
  };
}

/** Keeps a saved position usable after a monitor change: a strip fully off every screen is put back. */
export function clampBounds(saved, workArea) {
  const width = Math.min(saved.width ?? MUSIC_LYRICS_WINDOW.width, workArea.width);
  const height = Math.min(saved.height ?? MUSIC_LYRICS_WINDOW.height, workArea.height);
  const minX = workArea.x - width + MUSIC_LYRICS_WINDOW.edge;
  const maxX = workArea.x + workArea.width - MUSIC_LYRICS_WINDOW.edge;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - MUSIC_LYRICS_WINDOW.edge;
  return {
    x: Math.round(Math.min(Math.max(saved.x ?? 0, minX), maxX)),
    y: Math.round(Math.min(Math.max(saved.y ?? 0, minY), maxY)),
    width,
    height,
  };
}

/** The lyric strip's page. `theme` carries the now-playing palette so it matches the player. */
export function lyricsPage(input = {}) {
  const palette = {
    background: input.background ?? "rgba(10, 13, 20, 0.62)",
    active: input.active ?? "#f4f7ff",
    idle: input.idle ?? "rgba(226, 234, 250, 0.52)",
    glow: input.glow ?? "rgba(120, 200, 255, 0.5)",
    accent: input.accent ?? "#7fc4ff",
    font: input.font ?? "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    size: Number.isFinite(input.size) ? Math.min(Math.max(input.size, 14), 64) : 26,
    /** `horizontal` is the karaoke strip; `vertical` is the two-column panel. */
    layout: input.layout === "vertical" ? "vertical" : "horizontal",
    locked: input.locked === true,
  };
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: ${palette.font}; user-select: none; -webkit-user-select: none; }
  #strip { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center;
    gap: 6px; padding: 14px 22px; border-radius: 20px; background: ${palette.background};
    border: 1px solid ${palette.glow.replace("0.5", "0.22")};
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42); backdrop-filter: blur(18px); }
  body.vertical #strip { flex-direction: row; align-items: center; }
  #current { font-size: ${palette.size}px; font-weight: 600; color: ${palette.active};
    text-shadow: 0 0 22px ${palette.glow}; line-height: 1.25;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity 120ms ease; }
  #next { font-size: ${Math.max(12, Math.round(palette.size * 0.62))}px; color: ${palette.idle};
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  body.vertical #current { flex: 1 1 auto; }
  body.vertical #next { display: none; }
  #lock { position: absolute; top: 6px; right: 8px; width: 18px; height: 18px; border-radius: 5px;
    display: grid; place-items: center; color: ${palette.accent}; opacity: 0; transition: opacity 120ms ease; }
  body.locked #lock, #strip:hover #lock { opacity: 0.8; }
  #lock::before { content: "●"; font-size: 9px; }
  body.locked #lock::before { content: "■"; }
  .empty { color: ${palette.idle}; font-size: ${Math.round(palette.size * 0.7)}px; }
</style></head><body class="${palette.layout === "vertical" ? "vertical" : ""}${palette.locked ? " locked" : ""}">
  <div id="strip">
    <div id="current" class="empty">EACbot</div>
    <div id="next"></div>
    <div id="lock" title="锁定的歌词不可拖动"></div>
  </div>
<script>
  const current = document.getElementById("current");
  const next = document.getElementById("next");
  const lock = document.getElementById("lock");
  let lines = [], index = -1;
  function paint() {
    const line = lines[index];
    const following = lines[index + 1];
    current.textContent = line?.text || "";
    current.classList.toggle("empty", !line?.text);
    next.textContent = following?.text || "";
  }
  lock.addEventListener("click", () => { document.body.classList.toggle("locked"); });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.kind !== "lyrics") return;
    if (Array.isArray(data.lines)) lines = data.lines;
    if (typeof data.index === "number") index = data.index;
    if (data.locked !== undefined) document.body.classList.toggle("locked", data.locked === true);
    paint();
  });
</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** A small preload so the page can ask the main process to lock or close without a runtime. */
export function lyricsPreloadSource() {
  return [
    'const { ipcRenderer } = require("electron");',
    'window.addEventListener("DOMContentLoaded", () => {',
    '  document.addEventListener("dblclick", () => ipcRenderer.send("music-lyrics:toggle-lock"));',
    "});",
  ].join("\n");
}

/**
 * @param {object} options
 * @param {object} options.BrowserWindow  Electron's BrowserWindow
 * @param {object} options.screen         Electron's screen
 * @param {{ get(key: string): unknown, set(key: string, value: unknown): void }} options.prefs
 * @param {string} [options.prefsKey]     the key the strip's bounds are stored under
 * @param {(locked: boolean) => void} [options.onToggleLock]
 * @param {object} [options.theme]        the now-playing palette
 */
export function createMusicLyricsWindow(options) {
  const { BrowserWindow, screen, prefs } = options;
  const prefsKey = options.prefsKey ?? "musicLyricsBounds";
  /** @type {object|null} */
  let win = null;
  let clickThrough = true;
  let lockedState = false;
  let layoutState = "horizontal";
  let ready = false;

  const workArea = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const live = () => (win && !win.isDestroyed() ? win : null);

  const savedBounds = () => {
    const stored = prefs.get(prefsKey);
    if (!stored || typeof stored.x !== "number" || typeof stored.y !== "number") return lyricsBounds(workArea());
    return clampBounds(stored, workArea());
  };

  const remember = () => {
    const target = live();
    if (!target) return;
    try {
      const bounds = target.getBounds();
      prefs.set(prefsKey, bounds);
    } catch {
      // A window torn down mid-save is not worth an error.
    }
  };

  const create = () => {
    const existing = live();
    if (existing) return existing;
    const area = workArea();
    const bounds = savedBounds();
    const target = new BrowserWindow({
      ...bounds,
      type: "panel",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: layoutState === "vertical",
      movable: !lockedState,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // Electron/macOS: lets a click on an inactive window reach the page.
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        preload: fileURLToPath(new URL("./music-lyrics-preload.cjs", import.meta.url)),
      },
    });
    target.excludedFromShownWindowsMenu = true;
    target.setAlwaysOnTop(true, MUSIC_LYRICS_WINDOW.level);
    // Electron/macOS: skipTransformProcessType keeps the Dock icon.
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    target.setIgnoreMouseEvents(clickThrough, { forward: true });
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-navigate", (event) => event.preventDefault());
    target.webContents.on("did-finish-load", () => {
      ready = true;
      if (layoutState === "vertical") target.setBounds({ ...target.getBounds(), height: Math.round(area.height * 0.18) });
    });
    target.on("moved", remember);
    target.on("resized", remember);
    target.on("closed", () => {
      if (win === target) { win = null; ready = false; }
    });
    target.loadURL(lyricsPage({ ...options.theme, layout: layoutState, locked: lockedState })).catch(() => {});
    win = target;
    return target;
  };

  const send = (payload) => {
    const target = live();
    if (!target || !ready) return;
    try {
      target.webContents.send("music-lyrics:state", payload);
    } catch {
      // A window closing between the check and the send is fine.
    }
  };

  return {
    show(input) {
      if (!input.lines.length) {
        this.hide();
        return;
      }
      const target = create();
      if (!target.isVisible()) target.showInactive();
      send({ kind: "lyrics", lines: input.lines.map((line) => ({ text: line.text })), index: input.index, locked: lockedState });
    },

    hide() {
      const target = live();
      if (!target) return;
      remember();
      target.hide();
    },

    setClickThrough(through) {
      clickThrough = through;
      live()?.setIgnoreMouseEvents(through, { forward: true });
    },

    locked: () => lockedState,

    setLocked(locked) {
      lockedState = locked;
      live()?.setMovable(!locked);
      send({ kind: "lyrics", locked });
      options.onToggleLock?.(locked);
    },

    layout: () => layoutState,

    setLayout(layout) {
      layoutState = layout;
      const target = live();
      if (!target) return;
      // A vertical strip is a taller box; a horizontal one is a wide band.
      const area = workArea();
      const bounds = target.getBounds();
      target.setBounds({
        ...bounds,
        height: layout === "vertical" ? Math.round(area.height * 0.18) : MUSIC_LYRICS_WINDOW.height,
        width: layout === "vertical" ? Math.round(area.width * 0.22) : Math.min(bounds.width, MUSIC_LYRICS_WINDOW.width),
      });
      target.setResizable(layout === "vertical");
      target.loadURL(lyricsPage({ ...options.theme, layout, locked: lockedState })).catch(() => {});
      ready = false;
    },

    destroy() {
      const target = live();
      if (!target) return;
      remember();
      target.destroy();
      win = null;
      ready = false;
    },
  };
}

export function isMusicLyricsWindow(win) {
  return Boolean(win && !win.isDestroyed() && win.getTitle() === "" && win.isAlwaysOnTop());
}
