/**
 * Wire types of the herdr-core API this client speaks.
 *
 * Field names and optionality follow `hc.openrpc.json` at schema version
 * 0.1.21 (herdr-core commit c84d6e76156a6c2aac1da20efbe800f10acfe897).
 */

export type TerminalState = "live" | "finished";

/** Why a program ended, or why a kept terminal waits for a new shell. */
export type TerminalReason =
  | "exited"
  | "killed"
  | "server_stop"
  | "host_shutdown"
  | "signaled"
  | "holder_lost"
  | "stopped_by_restart"
  | "spawn_pending";

/** One OSC 7501 record. Words are the program's own; nothing is translated. */
export interface Status {
  state: string;
  app?: string;
  msg?: string;
  title?: string;
  kind?: string | null;
  progress?: number | null;
}

export interface Foreground {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
}

export interface FirstMessage {
  sent: boolean;
  reason?: string | null;
  started?: boolean | null;
  turn?: number | null;
}

export interface Terminal {
  address: string;
  argv: string[];
  cwd: string;
  state: TerminalState;
  created_ms: number;
  screen: "exact" | "inexact" | string;
  cols: number;
  rows: number;
  labels: Record<string, string>;
  name?: string | null;
  parent?: string | null;
  pid?: number | null;
  title?: string;
  turn?: number;
  keep?: boolean;
  rm?: boolean;
  notify?: boolean;
  die_with_parent?: boolean;
  identity?: string;
  template?: string | null;
  exit_code?: number | null;
  signal?: number | null;
  reason?: TerminalReason | string | null;
  finished_ms?: number | null;
  status?: Status | null;
  status_ms?: number | null;
  records?: Record<string, Status>;
  reported?: boolean;
  foreground?: Foreground | null;
  first_message?: FirstMessage | null;
  submit?: string | null;
  stop?: string | null;
  paste_gap_ms?: number | null;
}

/** A viewer's own colors and cell size, reported by the client. */
export interface Display {
  fg?: string | null;
  bg?: string | null;
  cursor?: string | null;
  /** `[width, height]` in pixels. */
  cell?: [number, number] | null;
}

export interface CoreInfo {
  id: string;
  name: string;
}

export interface LoginSession {
  [key: string]: unknown;
}

export interface HelloResult {
  generation: number;
  version: string;
  core: CoreInfo;
  framed: boolean;
  methods: string[];
  features: string[];
  login_session?: LoginSession | null;
  keeps_running_after_logout?: boolean | null;
  logout_linger_user?: string | null;
}

export interface MachineView {
  name: string;
  target: string;
  id: string;
  host: string;
  version: string;
  state: "connecting" | "connected" | "needs_login" | "unreachable" | string;
  via?: boolean;
  temporary?: boolean;
  session?: string | null;
  keeps_running_after_logout?: boolean | null;
  logout_linger_user?: string | null;
  since_ms?: number | null;
  why?: string | null;
}

export interface ListResult {
  terminals: Terminal[];
  hidden_finished: number;
  machines: MachineView[];
}

export interface InitialSize {
  cols: number;
  rows: number;
}

export interface RunParams {
  argv?: string[];
  line?: string | null;
  name?: string | null;
  cwd?: string | null;
  size?: InitialSize | null;
  display?: Display | null;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  parent?: string | null;
  no_parent?: boolean;
  no_notify?: boolean;
  outlive_parent?: boolean;
  die_with_parent?: boolean;
  rm?: boolean;
  keep?: boolean;
  wait?: boolean;
  timeout?: number | null;
  on?: string | null;
  caller?: string | null;
}

export interface WaitResult {
  ended: boolean;
  reason?: string | null;
  status?: Status | null;
  turn?: number | null;
  exit_code?: number | null;
  from?: string | null;
}

export interface RunResult extends Terminal {
  output?: string | null;
  wait?: WaitResult | null;
}

export interface AttachParams {
  terminal: string;
  cols: number;
  rows: number;
  history?: number;
  observe?: boolean;
  resize_notifications?: boolean;
  resumed?: boolean;
  display?: Display;
  caller?: string | null;
}

export interface AttachResult {
  channel: number;
  terminal: Terminal;
  /** The whole attach path accepts AUTOMATIC_INPUT (kind 6). Absent: use DATA. */
  automatic_input: boolean;
  /** True only when the entire path sends RESIZE before replacement paints. */
  resize_notifications: boolean;
}

export interface SendParams {
  terminal: string;
  text: string;
  force?: boolean;
  if?: "idle" | "working" | null;
  wait?: boolean;
  timeout?: number | null;
  caller?: string | null;
}

export interface SendResult {
  turn: number;
  started?: boolean | null;
  status?: string | null;
  wait?: WaitResult | null;
}

export interface InterruptParams {
  terminal: string;
  timeout?: number | null;
}

export interface InterruptResult {
  outcome: "stopped" | "exited" | "still_working" | "unknown" | string;
  key: string;
}

export interface KeepParams {
  terminal: string;
  keep: boolean;
}

export interface SubscribeParams {
  terminal?: string | null;
  children_of?: string | null;
  labels?: Record<string, string>;
  docs?: string[];
}

export interface SubscribeResult {
  seq: number;
  terminals: Terminal[];
  channel?: number | null;
}

export type EventType =
  | "created"
  | "lost"
  | "restarted"
  | "keep"
  | "finished"
  | "removed"
  | "status"
  | "turn"
  | "title"
  | "labels"
  | "size"
  | "foreground"
  | "doc";

export interface EventParams {
  seq: number;
  type: EventType | string;
  terminal?: string;
  machine?: string;
  data: unknown;
}

export interface HeartbeatParams {
  seq: number;
}

export interface MissedParams {
  seq: number;
  terminals: Terminal[];
}
