export const HOST_FEATURES = [
  "openExternal",
  "chooseFolder",
  "desktopNotifications",
  "tray",
  "transparentOverlay",
  "secureStorage",
  "automaticUpdate",
  "microphone",
] as const;

export type HostFeature = (typeof HOST_FEATURES)[number];

export type HostKind = "web" | "electron" | "tauri";

export type HostFeatureState =
  | { state: "available" }
  | { state: "unsupported"; reason: string };

export interface HostDeclaration {
  apiVersion: 1;
  kind: "electron" | "tauri";
  /** Only what the host really implements; anything absent is unsupported, not guessed. */
  features: Partial<Record<HostFeature, "available">>;
  /** The commands each feature may run through `invoke`; an unlisted command is refused. */
  commands?: Partial<Record<HostFeature, string[]>>;
  invoke?(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface ElectronBridge {
  openExternal?(url: string): Promise<boolean>;
  pickFolder?(current?: string): Promise<string | null>;
  desktopNotifications?: unknown;
}

export interface HostScope {
  __EAC_HOST__?: HostDeclaration;
  ogb?: ElectronBridge;
  openExternal?(url: string): Promise<boolean>;
  pickFolder?(): Promise<string | null>;
}

export class HostUnsupportedError extends Error {
  readonly feature: HostFeature;
  constructor(feature: HostFeature, reason: string) {
    super(reason);
    this.feature = feature;
  }
}

const UNSUPPORTED_REASON: Readonly<Record<HostKind, Partial<Record<HostFeature, string>>>> = {
  web: {
    chooseFolder: "a browser cannot open a native folder picker",
    desktopNotifications: "browser notifications depend on a user permission this page cannot request here",
    tray: "a browser has no tray",
    transparentOverlay: "a browser cannot draw a transparent always-on-top window",
    secureStorage: "the OS credential store is not reachable from a browser page",
    automaticUpdate: "a browser page cannot update the app",
    microphone: "microphone use needs a user gesture and browser permission",
  },
  electron: {},
  tauri: {},
};

/** Only an explicit declaration or a real bridge function makes a feature available. */
export function createHostAdapter(scope: HostScope): HostAdapter {
  const declared = scope.__EAC_HOST__;
  const kind: HostKind = declared?.kind === "tauri" || declared?.kind === "electron"
    ? declared.kind
    : scope.ogb
      ? "electron"
      : "web";
  const available = new Set<HostFeature>();
  if (declared?.apiVersion === 1) {
    for (const feature of HOST_FEATURES) if (declared.features[feature] === "available") available.add(feature);
  }
  if (scope.ogb?.openExternal) available.add("openExternal");
  if (scope.ogb?.pickFolder) available.add("chooseFolder");
  if (kind === "web" && scope.openExternal) available.add("openExternal");

  const capability = (feature: HostFeature): HostFeatureState => available.has(feature)
    ? { state: "available" }
    : { state: "unsupported", reason: UNSUPPORTED_REASON[kind][feature] ?? `${kind} does not provide ${feature}` };

  const require = (feature: HostFeature): void => {
    const state = capability(feature);
    if (state.state !== "available") throw new HostUnsupportedError(feature, state.reason);
  };

  return {
    kind,
    apiVersion: 1,
    capability,
    async openExternal(url: string): Promise<boolean> {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("only http(s) links can open outside the app");
      require("openExternal");
      // These two commands are fixed by this adapter, not named by a caller.
      if (declared?.invoke) return Boolean(await declared.invoke("open_external", { url: parsed.toString() }));
      if (scope.ogb?.openExternal) return scope.ogb.openExternal(parsed.toString());
      if (scope.openExternal) return scope.openExternal(parsed.toString());
      throw new HostUnsupportedError("openExternal", "no external-link handler is installed");
    },
    async chooseFolder(current?: string): Promise<string | null> {
      require("chooseFolder");
      if (declared?.invoke) return await declared.invoke("choose_folder", current ? { current } : {}) as string | null;
      if (scope.ogb?.pickFolder) return scope.ogb.pickFolder(current);
      throw new HostUnsupportedError("chooseFolder", "no folder picker is installed");
    },
    async invoke<T>(feature: HostFeature, command: string, args?: Record<string, unknown>): Promise<T> {
      require(feature);
      if (!declared?.invoke) throw new HostUnsupportedError(feature, `${kind} has no command bridge`);
      // The bridge is the host's own; a page cannot name an arbitrary command through it.
      const allowed = declared.commands?.[feature];
      if (!allowed?.includes(command)) {
        throw new HostUnsupportedError(feature, `${kind} does not declare the ${command} command`);
      }
      return await declared.invoke(command, args) as T;
    },
  };
}

export interface HostAdapter {
  kind: HostKind;
  apiVersion: 1;
  capability(feature: HostFeature): HostFeatureState;
  openExternal(url: string): Promise<boolean>;
  chooseFolder(current?: string): Promise<string | null>;
  invoke<T>(feature: HostFeature, command: string, args?: Record<string, unknown>): Promise<T>;
}

export function detectHostAdapter(scope: HostScope = globalThis as unknown as HostScope): HostAdapter {
  return createHostAdapter(scope);
}
