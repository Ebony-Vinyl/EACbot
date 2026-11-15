/**
 * What a person may type into the "add my own computer" form, and what this
 * application will send.
 *
 * The route accepts connection facts only — label, host, port, user and the
 * fingerprint the person read off the computer. This application owns its own
 * known-hosts file, generates it in its data directory, and never takes a path
 * for it; and a sign-in mode belongs to an agent instance, not to a computer,
 * so nothing here asks for one.
 *
 * There is no password field and no private-key field, because the environment
 * agent resolves credentials itself: a key that travelled through a browser is
 * a key in a browser's memory, its devtools and its crash dumps.
 */
export interface SshDraft {
  readonly label: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly fingerprint: string;
}

export type DraftField = keyof SshDraft;

export type FieldErrors = Partial<Record<DraftField, string>>;

export const EMPTY_DRAFT: SshDraft = { label: "", host: "", port: "22", user: "", fingerprint: "" };

/** Fields that would carry key material or a password if a form ever offered
 * them. A body carrying one is refused before it becomes a request. */
export const SECRET_FIELDS = ["password", "passphrase", "privateKey", "privateKeyPath", "keyBody", "token", "apiKey", "secret", "knownHostsFile"] as const;

const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const SHA256 = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MD5 = /^MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/i;

export function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value.trim())) return undefined;
  const port = Number(value.trim());
  return port >= 1 && port <= 65535 ? port : undefined;
}

export function validateDraft(draft: SshDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.label.trim().length === 0) errors.label = "Give this computer a name you will recognise.";
  else if (draft.label.trim().length > 200) errors.label = "Keep the name under 200 characters.";

  const host = draft.host.trim();
  if (host.length === 0) errors.host = "Enter the host name or address.";
  else if (host.length > 253) errors.host = "That is longer than a host name can be.";
  else if (!HOSTNAME.test(host) && !IPV6.test(host)) errors.host = "Enter a host name, an IPv4 address, or an IPv6 address in brackets.";

  if (parsePort(draft.port) === undefined) errors.port = "A port is a whole number from 1 to 65535.";

  const user = draft.user.trim();
  if (user.length === 0) errors.user = "Enter the account to connect as.";
  else if (!USER.test(user)) errors.user = "Use letters, digits, underscores and hyphens, starting with a letter or underscore.";
  else if (user === "root") errors.user = "This application installs as a non-root account. Create or name one.";

  const fingerprint = draft.fingerprint.trim();
  if (fingerprint.length === 0) errors.fingerprint = "Paste the fingerprint the computer printed.";
  else if (!SHA256.test(fingerprint) && !MD5.test(fingerprint)) {
    errors.fingerprint = "A fingerprint is SHA256: followed by 43 characters, or the MD5: form ssh also prints.";
  }
  return errors;
}

export function isDraftValid(draft: SshDraft): boolean {
  return Object.keys(validateDraft(draft)).length === 0;
}

/** The body the environment route accepts. */
export interface EnvironmentRequest {
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint: string;
}

export function environmentRequest(draft: SshDraft): EnvironmentRequest {
  const errors = validateDraft(draft);
  const first = Object.keys(errors)[0] as DraftField | undefined;
  if (first !== undefined) throw new Error(errors[first]);
  const port = parsePort(draft.port);
  if (port === undefined) throw new Error("A port is a whole number from 1 to 65535.");
  return {
    label: draft.label.trim(),
    host: draft.host.trim(),
    port,
    user: draft.user.trim(),
    hostKeyFingerprint: draft.fingerprint.trim(),
  };
}

/** True when a body carries a field that could be key material, a password, or
 * a path this application owns. Called on the way out, so a future refactor
 * that widens the form cannot widen what a request carries. */
export function carriesSecret(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => (SECRET_FIELDS as readonly string[]).includes(key));
}

export interface ConnectionReport {
  readonly reachable: boolean;
  readonly latencyMs?: number;
  readonly detail?: string;
  readonly checkedAt: string;
}

/** What to show after a test. A check that did not open a connection says so;
 * it never borrows the word "connected" for "we did not try". */
export function describeConnection(report: ConnectionReport | undefined): { readonly tone: "success" | "error"; readonly text: string } {
  if (report === undefined) return { tone: "error", text: "这台电脑还没有检查过。" };
  if (report.reachable) {
    const latency = report.latencyMs !== undefined ? `，用时 ${report.latencyMs} ms` : "";
    const detail = report.detail !== undefined && report.detail.length > 0 ? ` ${report.detail}` : "";
    return { tone: "success", text: `已连上这台电脑${latency}。${detail}`.trim() };
  }
  return {
    tone: "error",
    text: report.detail !== undefined && report.detail.length > 0 ? `连不上：${report.detail}` : "连不上，而且没有任何传输层报告原因。",
  };
}

export interface EnvironmentRecord {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint?: string;
  readonly status?: string;
  readonly lastTest?: ConnectionReport;
}

/** Why a stored pin and the key a computer presents would disagree. The
 * application never rewrites a pin from a live connection: a changed key means
 * removing the record and adding the computer again with a fingerprint the
 * person read off the machine. */
export function hostKeyWarning(status: string | undefined): string | undefined {
  if (status !== "hostKeyChanged") return undefined;
  return `这台电脑现在提供的主机指纹和记录里的不一致。如果你没有换过它，请停下来：连接可能被拦截。只有在你能看到的那台电脑上核对过指纹之后，才删除记录并重新添加、重新确认指纹。`;
}

/** Whether the record has a pin to compare against at all. A record without
 * one cannot be trusted to connect. */
export function hasPin(record: EnvironmentRecord): boolean {
  return record.hostKeyFingerprint !== undefined && record.hostKeyFingerprint.trim().length > 0;
}
