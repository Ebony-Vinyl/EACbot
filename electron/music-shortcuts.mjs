// The music player's global shortcuts, registered when the app has focus anywhere
// but still delivered to the player. Defaults follow upstream's shortcut table;
// a key the OS or another app already holds reports `taken` instead of failing.
const ACTIONS = [
  { id: "playPause", accelerator: "Control+Alt+Space" },
  { id: "previousTrack", accelerator: "Control+Alt+Left" },
  { id: "nextTrack", accelerator: "Control+Alt+Right" },
  { id: "toggleDesktopLyric", accelerator: "Control+Alt+L" },
  { id: "volumeUp", accelerator: "Control+Alt+Shift+Up" },
  { id: "volumeDown", accelerator: "Control+Alt+Shift+Down" },
];

export const MUSIC_SHORTCUT_UNAVAILABLE = Object.freeze({
  available: false,
  enabled: false,
  keys: Object.fromEntries(ACTIONS.map(({ id, accelerator }) => [id, accelerator])),
  taken: [],
});

export function createMusicShortcuts({ globalShortcut, prefs, available, onCommand }) {
  const registered = new Map();
  let taken = [];

  const enabled = () => prefs.musicShortcutsEnabled?.() ?? true;
  const acceleratorFor = (id) => prefs.musicShortcutKey?.(id) ?? ACTIONS.find((action) => action.id === id)?.accelerator;

  const release = () => {
    for (const [accelerator] of registered) globalShortcut.unregister(accelerator);
    registered.clear();
    taken = [];
  };

  const apply = () => {
    release();
    if (!available() || !enabled()) return;
    for (const { id } of ACTIONS) {
      const accelerator = acceleratorFor(id);
      if (!accelerator) continue;
      if (globalShortcut.register(accelerator, () => onCommand(id))) registered.set(accelerator, id);
      else taken.push(id);
    }
  };

  apply();

  return {
    state: () => ({
      available: available(),
      enabled: enabled(),
      keys: Object.fromEntries(ACTIONS.map(({ id }) => [id, acceleratorFor(id)])),
      taken,
    }),
    set(change) {
      if (!available()) return this.state();
      if (typeof change?.enabled === "boolean") prefs.setMusicShortcutsEnabled?.(change.enabled);
      for (const [id, accelerator] of Object.entries(change?.keys ?? {})) {
        if (typeof accelerator === "string") prefs.setMusicShortcutKey?.(id, accelerator);
      }
      apply();
      return this.state();
    },
    refresh: apply,
    close: release,
  };
}
