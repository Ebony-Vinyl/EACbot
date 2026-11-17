export const TERMINAL_KINDS = ["nativeTui", "pty", "exec"] as const;

export type TerminalKind = (typeof TERMINAL_KINDS)[number];

/** A terminal attached to a run. Its id is distinct from every agent native
 * session id; closing it never changes a mission. */
export interface TerminalRef {
  readonly id: string;
  readonly kind: TerminalKind;
  readonly missionId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly closedAt?: string;
  readonly exitCode?: number;
}

declare const TERMINAL_STATUS_BRAND: unique symbol;

/** Status reported by the terminal stream itself (process exit, OSC 7501 and
 * the like). It is a signal about a terminal, never a mission input: the
 * brand and the `kind` field keep it out of every mission event union. */
export interface TerminalStatusSignal {
  readonly [TERMINAL_STATUS_BRAND]: true;
  readonly kind: "terminal.status";
  readonly terminalId: string;
  readonly state: "running" | "exited" | "unknown";
  readonly at: string;
  readonly exitCode?: number;
  readonly source: "osc7501" | "processExit" | "pty";
}
