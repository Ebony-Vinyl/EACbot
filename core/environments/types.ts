/**
 * The user-owned computer as this layer models it, and the checks around it.
 *
 * A record holds connection facts and observed machine state. It never holds
 * key material: `identityFileRef` names a credential the caller resolves into a
 * path at connect time, and no path, key body or password is persisted here.
 */

export const ENVIRONMENT_STATUSES = [
  "unknown",
  "online",
  "unreachable",
  "hostKeyChanged",
  "diskLow",
  "needsUpdate",
  "permissionDenied",
] as const;

export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

/** Executable names, as a person would type them on their own computer. */
export const TOOL_NAMES = ["hermes", "claude", "codex", "opencode", "pi", "omp"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_STATUSES = ["installed", "missing", "outdated", "notThisTool", "probeFailed"] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

export interface InstalledTool {
  readonly name: ToolName;
  readonly status: ToolStatus;
  /** Absolute path on the remote computer, as `command -v` answered. */
  readonly path: string | null;
  readonly version: string | null;
  readonly detail?: string;
}

/** What the computer is, as it answered. `null` means the probe did not get an
 * answer, never a default: a guessed shell or home directory would be acted on. */
export interface EnvironmentCapabilities {
  readonly os: string | null;
  readonly arch: string | null;
  readonly shell: string | null;
  readonly homeDir: string | null;
  readonly diskFreeBytes: number | null;
  /** `false` when the login user is root, which this layer refuses to install into. */
  readonly nonRoot: boolean | null;
}

export const UNKNOWN_CAPABILITIES: EnvironmentCapabilities = {
  os: null,
  arch: null,
  shell: null,
  homeDir: null,
  diskFreeBytes: null,
  nonRoot: null,
};

export interface EnvironmentRecord {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** This application's own known-hosts file, absolute. */
  readonly knownHostsFile: string;
  readonly hostKeyFingerprint: string;
  readonly identityFileRef: string | null;
  readonly status: EnvironmentStatus;
  readonly lastSeen: string | null;
  readonly capabilities: EnvironmentCapabilities;
  readonly tools: readonly InstalledTool[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface EnvironmentDraft {
  readonly label: string;
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly knownHostsFile: string;
  readonly hostKeyFingerprint: string;
  readonly identityFileRef?: string | null;
}

/** The persisted document. `version` is the migration key: a file without one
 * was written before this shape existed. */
export interface EnvironmentDocument {
  readonly version: number;
  readonly environments: readonly EnvironmentRecord[];
}

export const DOCUMENT_VERSION = 1;

export interface ProbeSnapshot {
  readonly status: EnvironmentStatus;
  readonly capabilities: EnvironmentCapabilities;
  readonly tools: readonly InstalledTool[];
  readonly lastSeen: string | null;
}

export interface HostKeyInput {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa` and their peers. */
  readonly keyType: string;
  /** The key's base64 body, as a known-hosts line carries it. */
  readonly keyBlob: string;
}
