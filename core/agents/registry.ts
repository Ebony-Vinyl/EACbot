import type { AgentId, AgentCapabilities, TransportKind } from "./contracts.ts";
import type { AuthMode } from "./env.ts";

/** How a person installs the agent. Only a fixed argv descriptor is produced: EACbot never pipes a
 * vendor script into a shell, and an installer command is shown to the person, not run. */
export interface InstallDescriptor {
  /** The official npm package, when one exists. */
  npmPackage?: string;
  /** The vendor's own installer, printed for the person to run themselves. Never executed. */
  vendorInstaller?: { darwin?: string; linux?: string; win32?: string };
  docsUrl: string;
  /** Interactive sign-in a person runs in a terminal after installing. */
  signInCommand?: string;
  needsNode?: boolean;
}

export interface VersionProbe {
  /** argv that makes the CLI print its version, e.g. `--version`. */
  args: readonly string[];
  /** The first line's shape. Another answer means the path runs another program. */
  pattern: RegExp;
}

export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  transport: TransportKind;
  /** The executable an instance starts, when it is a CLI. */
  cli?: string;
  install: InstallDescriptor;
  version?: VersionProbe;
  /** A fixed argv that opens the engine's own TUI in a terminal pane. */
  tui: readonly string[];
  /** The environment variable that relocates this engine's own home, when it has one. */
  homeEnv?: string;
  /** Sub-path under the instance home that this engine owns. Distinct per engine so Pi and Oh My
   * Pi can never share config, credentials or sessions. */
  homeDir: string;
  capabilities: AgentCapabilities;
  authModes: readonly AuthMode[];
  /** A transport fact worth surfacing in the UI, never a claim about the model. */
  note?: string;
}

const NO_STEER = { kind: "none", reason: "this engine has no mid-turn input channel" } as const;

/** The one place an agent is described. Adding an agent means adding a row here and an adapter,
 * never a second registry. */
export const AGENT_REGISTRY: Readonly<Record<AgentId, AgentDescriptor>> = {
  hermes: {
    id: "hermes",
    displayName: "Hermes",
    transport: "http",
    install: {
      vendorInstaller: {
        darwin: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
        linux: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
        win32: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
      },
      docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
      signInCommand: "hermes setup",
    },
    tui: ["hermes"],
    homeDir: "hermes",
    capabilities: {
      steer: { kind: "next-boundary", note: "delivered at the agent's next tool boundary, not folded into the running step" },
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: false,
      usage: true,
      modelSwitch: "in-session",
      modelCatalog: "native",
      nativeTui: true,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
    note: "HTTP Runs API; run ids and the native session id are the engine's own, and the native id is only ever what GET /v1/runs echoes back",
  },
  claudeCode: {
    id: "claudeCode",
    displayName: "Claude Code",
    transport: "stdio-stream-json",
    cli: "claude",
    install: {
      npmPackage: "@anthropic-ai/claude-code",
      docsUrl: "https://claude.com/claude-code",
      signInCommand: "claude auth login",
      needsNode: true,
    },
    version: { args: ["--version"], pattern: /^(\d+\.\d+\.\d+)\s+\(Claude Code\)/ },
    tui: ["claude"],
    homeDir: "claude",
    capabilities: {
      steer: { kind: "native" },
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: true,
      usage: true,
      modelSwitch: "in-session",
      modelCatalog: "none",
      nativeTui: true,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint"],
    note: "one long-lived process per session; --resume carries the native session id. Its stream-json mode reports no model catalog, so a model is passed as --model",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    transport: "stdio-json-rpc",
    cli: "codex",
    install: {
      npmPackage: "@openai/codex",
      docsUrl: "https://github.com/openai/codex",
      signInCommand: "codex login",
      needsNode: true,
    },
    version: { args: ["--version"], pattern: /^codex-cli\s+(\d+\.\d+\.\d+)/ },
    tui: ["codex"],
    homeDir: "codex",
    capabilities: {
      steer: { kind: "native" },
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: true,
      usage: true,
      modelSwitch: "in-session",
      modelCatalog: "native",
      nativeTui: true,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint"],
    note: "app-server JSON-RPC over stdio; thread ids are the engine's own and model/list supplies the catalog",
  },
  openCode: {
    id: "openCode",
    displayName: "OpenCode",
    transport: "http",
    cli: "opencode",
    install: {
      npmPackage: "opencode-ai",
      docsUrl: "https://opencode.ai/docs/server/",
      signInCommand: "opencode auth login",
      needsNode: true,
    },
    version: { args: ["--version"], pattern: /^(\d+\.\d+\.\d+)/ },
    tui: ["opencode"],
    homeDir: "opencode",
    capabilities: {
      steer: { kind: "native" },
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: false,
      usage: true,
      modelSwitch: "in-session",
      modelCatalog: "native",
      nativeTui: true,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
    note: "fixed V2 HTTP surface: /api/session, /api/session/{id}/prompt, one global /api/event stream filtered by sessionID, /api/model",
  },
  pi: {
    id: "pi",
    displayName: "Pi",
    transport: "stdio-jsonl",
    cli: "pi",
    install: {
      npmPackage: "@earendil-works/pi-coding-agent",
      docsUrl: "https://pi.dev",
      needsNode: true,
    },
    version: { args: ["--version"], pattern: /^(\d+\.\d+\.\d+)/ },
    tui: ["pi"],
    homeEnv: "PI_HOME",
    homeDir: "pi",
    capabilities: {
      steer: { kind: "native" },
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: true,
      usage: true,
      modelSwitch: "in-session",
      modelCatalog: "native",
      nativeTui: true,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
    note: "JSONL RPC on stdio; a turn settles on agent_settled, or on agent_end unless it is not terminal. get_available_models supplies the catalog",
  },
  ohMyPi: {
    id: "ohMyPi",
    displayName: "Oh My Pi",
    transport: "stdio-jsonl",
    cli: "omp",
    install: {
      npmPackage: "@oh-my-pi/pi-coding-agent",
      docsUrl: "https://omp.sh/docs",
      needsNode: true,
    },
    version: { args: ["--version"], pattern: /^(\d+\.\d+\.\d+)/ },
    tui: ["omp"],
    homeEnv: "OMP_HOME",
    homeDir: "oh-my-pi",
    capabilities: {
      steer: { kind: "native" },
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: true,
      usage: true,
      modelSwitch: "in-session",
      modelCatalog: "native",
      nativeTui: true,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint", "local"],
    note: "JSONL RPC v2; frames over 1 MiB arrive as rpc_chunk pieces that must be reassembled. get_available_models supplies the catalog",
  },
  custom: {
    id: "custom",
    displayName: "Custom ACP agent",
    transport: "stdio-json-rpc",
    install: {
      docsUrl: "https://agentclientprotocol.com/",
    },
    tui: [],
    // No version probe: the agent is whatever executable the person configured, and it has no
    // agreed --version line to read.
    homeDir: "custom-acp",
    capabilities: {
      // ACP has no steering method. Claiming one would be a lie the caller acts on.
      steer: NO_STEER,
      interrupt: true,
      resume: true,
      cancel: true,
      approvals: true,
      questions: true,
      images: false,
      usage: false,
      modelSwitch: "unsupported",
      modelCatalog: "none",
      nativeTui: false,
    },
    authModes: ["subscription", "apiKey", "compatibleEndpoint"],
    note: "capabilities are what the agent advertises at initialize; steering is not one of them, and its catalog is read only by opening a session",
  },
};

export function agentDescriptor(id: AgentId): AgentDescriptor {
  return AGENT_REGISTRY[id];
}

/** The fixed argv that launches an engine's TUI. Empty means the engine has none, which the
 * caller reports rather than substituting a generic shell. */
export function tuiArgv(id: AgentId): readonly string[] {
  return AGENT_REGISTRY[id].tui;
}

/** The version line's triple, when it matches this engine's own shape. */
export function parseVersionLine(id: AgentId, line: string): string | null {
  const probe = AGENT_REGISTRY[id].version;
  if (!probe) return null;
  const match = probe.pattern.exec(line.trim());
  return match?.[1] ?? null;
}
