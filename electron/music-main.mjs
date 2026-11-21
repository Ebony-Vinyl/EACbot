// The music window's main-process side: the desktop lyric strip, and nothing else.
// The player itself lives in the server and the renderer; this only owns a window
// that must sit above every other app, which the renderer cannot do.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createMusicLyricsWindow } from "./music-lyrics.mjs";

/** The strip's bounds file: its position is not a desktop preference, but it belongs beside them. */
export function musicWindowPrefs(userDataPath) {
  const file = join(userDataPath, "music-lyrics.json");
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) ?? {};
  } catch {
    cache = {};
  }
  return {
    get: (key) => cache[key],
    set: (key, value) => {
      cache = { ...cache, [key]: value };
      try {
        writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
      } catch {
        // A failed save only costs the position.
      }
    },
  };
}

export function installMusic({ ipcMain, localOnly, BrowserWindow, screen, userDataPath, setTrayMusic, log = () => {} }) {
  const prefs = musicWindowPrefs(userDataPath);
  /** One strip per app, created on first use so a person who never opens it pays nothing. */
  let lyrics = null;

  const strip = () => {
    lyrics ??= createMusicLyricsWindow({
      BrowserWindow,
      screen,
      prefs,
      onToggleLock: (locked) => log(`music lyrics ${locked ? "locked" : "unlocked"}`),
    });
    return lyrics;
  };

  ipcMain.handle("music-lyrics:show", localOnly("music-lyrics:show", (_event, input) => {
    const lines = Array.isArray(input?.lines)
      ? input.lines.filter((line) => line && typeof line.text === "string").map((line) => ({ text: String(line.text).slice(0, 300) }))
      : [];
    const index = Number.isInteger(input?.index) ? Number(input.index) : -1;
    if (!lines.length) {
      lyrics?.hide();
      return { shown: false };
    }
    strip().show({ lines, index });
    return { shown: true, locked: strip().locked(), layout: strip().layout() };
  }));

  ipcMain.handle("music-lyrics:hide", localOnly("music-lyrics:hide", () => {
    lyrics?.hide();
    return { shown: false };
  }));

  ipcMain.handle("music-lyrics:state", localOnly("music-lyrics:state", () => (
    lyrics ? { locked: lyrics.locked(), layout: lyrics.layout() } : { locked: false, layout: "horizontal" }
  )));

  ipcMain.handle("music-lyrics:lock", localOnly("music-lyrics:lock", (_event, locked) => {
    strip().setLocked(locked === true);
    return { locked: strip().locked() };
  }));

  ipcMain.handle("music-lyrics:layout", localOnly("music-lyrics:layout", (_event, layout) => {
    strip().setLayout(layout === "vertical" ? "vertical" : "horizontal");
    return { layout: strip().layout() };
  }));

  /** Click-through is the default; a person turns it off to move the strip. */
  ipcMain.handle("music-lyrics:click-through", localOnly("music-lyrics:click-through", (_event, through) => {
    strip().setClickThrough(through !== false);
    return { clickThrough: through !== false };
  }));

  // A double-click inside the strip reaches this through the strip's own preload.
  ipcMain.on("music-lyrics:toggle-lock", () => {
    if (!lyrics) return;
    lyrics.setLocked(!lyrics.locked());
  });

  // The tray is a second face of the same player: it shows what is playing and its
  // clicks go back to the page, so there is still one queue and one revision.
  ipcMain.handle("music:tray-state", localOnly("music:tray-state", (_event, state) => { setTrayMusic?.(state ?? null); return { shown: Boolean(state) }; }));

  return {
    /** Closes the strip; the app calls this on quit so no window outlives the process. */
    destroy() {
      lyrics?.destroy();
      lyrics = null;
    },
  };
}
