/** Codex's `app-server` JSON-RPC surface (v2), as the adapter uses it. The method names and the
 * approval reply shapes are the protocol's, not ours; a change upstream is a change here. */

export interface CodexThreadRef {
  threadId: string;
}

export interface CodexTurnRef {
  threadId: string;
  turnId: string;
}

/** `initialize` params. `experimentalApi` is needed for the named permission profiles Codex 0.151
 * exposes; without it `thread/start` ignores them. */
export function initializeParams(clientVersion: string): Record<string, unknown> {
  return {
    clientInfo: { name: "eacbot-core", title: "EACbot", version: clientVersion },
    capabilities: { experimentalApi: true },
  };
}

export interface CodexThreadStartInput {
  cwd: string;
  model?: string;
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  instructions?: string;
}

export function threadStartParams(input: CodexThreadStartInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    ...(input.instructions ? { developerInstructions: input.instructions } : {}),
  };
}

/** One `turn/start` input item. Codex accepts an `image` item carrying a data URL and passes it
 * to the model as `input_image`; a file path would be unreadable in a sandboxed run. */
export type CodexInputItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export function turnStartParams(input: { threadId: string; text: string; images?: readonly string[] }): Record<string, unknown> {
  const items: CodexInputItem[] = [];
  if (input.text) items.push({ type: "text", text: input.text });
  for (const url of input.images ?? []) items.push({ type: "image", url });
  return {
    threadId: input.threadId,
    input: items.length ? items : [{ type: "text", text: "" }],
  };
}

/** `turn/steer` takes the running turn's id, so a steer can never land in a later turn. */
export function turnSteerParams(input: CodexTurnRef & { text: string }): Record<string, unknown> {
  return {
    threadId: input.threadId,
    expectedTurnId: input.turnId,
    input: [{ type: "text", text: input.text }],
  };
}

export function turnInterruptParams(input: CodexTurnRef): Record<string, unknown> {
  return { threadId: input.threadId, turnId: input.turnId };
}

/** The result Codex expects for a command/file approval request. Legacy methods take `approved`
 * strings; the current ones take an `accept`/`decline` decision. */
export function approvalResult(method: string, allow: boolean): Record<string, unknown> {
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  return {
    decision: allow ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline",
  };
}

/** Server-to-client request methods this adapter recognises. Anything else is declined rather
 * than accepted, so an unknown request can never widen permission by accident. */
export const APPROVAL_METHODS: readonly string[] = [
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "item/tool/requestUserInput",
];

export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.includes(method);
}

/** One notification, narrowed to the fields the adapter reads. */
export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export function codexNotification(frame: Record<string, unknown>): CodexNotification | null {
  if (typeof frame.method !== "string" || frame.id !== undefined) return null;
  const params = (frame.params ?? {}) as Record<string, unknown>;
  return { method: frame.method, params };
}

/** Item notifications the adapter turns into tool events. `userMessage` items are the engine
 * echoing the prompt back, which is not a tool call. */
export function toolItemTitle(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "commandExecution":
      return typeof item.command === "string" ? item.command : "shell";
    case "fileChange":
      return "edit";
    case "mcpToolCall":
      return typeof item.tool === "string" ? item.tool : "mcp";
    case "webSearch":
      return "web_search";
    default:
      return null;
  }
}

export function tokenUsage(params: Record<string, unknown>): { input: number; output: number; cachedInput?: number } | null {
  const total = (params.tokenUsage as { total?: Record<string, unknown> } | undefined)?.total;
  if (!total) return null;
  const input = typeof total.inputTokens === "number" ? total.inputTokens : 0;
  const output = typeof total.outputTokens === "number" ? total.outputTokens : 0;
  const cachedInput = typeof total.cachedInputTokens === "number" ? total.cachedInputTokens : undefined;
  return { input, output, ...(cachedInput === undefined ? {} : { cachedInput }) };
}
