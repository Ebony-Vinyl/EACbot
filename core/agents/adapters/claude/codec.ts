/** Claude Code's `--input-format stream-json --output-format stream-json` frames, as the adapter
 * reads and writes them. Kept apart from the session so the wire shapes are testable on their own. */

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeResultFrame {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  /** Steers the CLI has queued but no model call has taken yet (2.1.282). */
  queued_turn_count?: number;
}

export type ClaudeImageContent = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

export type ClaudeUserFrame = {
  type: "user";
  uuid?: string;
  message: { role: "user"; content: string | Array<ClaudeImageContent | { type: "text"; text: string }> };
};

export function userFrame(text: string, images: Array<{ mime: string; base64: string }> = [], uuid?: string): ClaudeUserFrame {
  if (!images.length) {
    return { type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content: text } };
  }
  const content: Array<ClaudeImageContent | { type: "text"; text: string }> = images.map((image) => ({
    type: "image" as const,
    source: { type: "base64", media_type: image.mime, data: image.base64 },
  }));
  if (text) content.push({ type: "text", text });
  return { type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content } };
}

/** The argv one Claude Code process runs with. `resume` carries the native session id; stdin
 * stays open so a steer needs no second process. */
export function claudeArgs(input: {
  resume?: string;
  model?: string;
  permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions";
  systemPrompt?: string;
}): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", input.permissionMode,
  ];
  if (input.resume) args.push("--resume", input.resume);
  if (input.model) args.push("--model", input.model);
  if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
  return args;
}

/** Text and reasoning deltas arrive inside `stream_event`'s own Anthropic-shaped event. */
export function streamEventDelta(frame: Record<string, unknown>): { kind: "text" | "reasoning"; text: string } | null {
  if (frame.type !== "stream_event") return null;
  const event = frame.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
  if (event?.type !== "content_block_delta" || !event.delta) return null;
  if (event.delta.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
    return { kind: "text", text: event.delta.text };
  }
  if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string" && event.delta.thinking) {
    return { kind: "reasoning", text: event.delta.thinking };
  }
  return null;
}

/** The native session id, from the `system:init` frame every turn of a live process announces. */
export function initSessionId(frame: Record<string, unknown>): string | null {
  if (frame.type !== "system" || frame.subtype !== "init") return null;
  return typeof frame.session_id === "string" && frame.session_id ? frame.session_id : null;
}

export function isResult(frame: Record<string, unknown>): frame is Record<string, unknown> & ClaudeResultFrame {
  return frame.type === "result";
}

/** Token totals for one result frame, in the adapter's own shape. */
export function resultUsage(result: ClaudeResultFrame): { input: number; output: number; cachedInput?: number } | null {
  const usage = result.usage;
  if (!usage) return null;
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const cachedInput = usage.cache_read_input_tokens;
  return {
    input: input + (cachedInput ?? 0),
    output: usage.output_tokens ?? 0,
    ...(cachedInput === undefined ? {} : { cachedInput }),
  };
}

/** An MCP elicitation or tool-permission control request, which the caller answers with
 * `control_response`. */
export interface ClaudeControlRequest {
  requestId: string;
  kind: "permission" | "question";
  title: string;
  detail?: string;
}

export function controlRequest(frame: Record<string, unknown>): ClaudeControlRequest | null {
  if (frame.type !== "control_request") return null;
  const requestId = typeof frame.request_id === "string" ? frame.request_id : "";
  if (!requestId) return null;
  const request = (frame.request ?? {}) as {
    subtype?: string; tool_name?: string; mcp_server_name?: string; message?: string; prompt?: string;
  };
  const subtype = request.subtype ?? "";
  const title = request.mcp_server_name ?? request.tool_name ?? subtype ?? "control request";
  if (subtype === "elicitation" || subtype === "can_use_tool" || subtype === "permission") {
    const detail = request.message ?? request.prompt;
    return {
      requestId,
      kind: subtype === "can_use_tool" ? "question" : "permission",
      title,
      ...(typeof detail === "string" ? { detail } : {}),
    };
  }
  return null;
}

export function controlResponse(requestId: string, response: Record<string, unknown>): Record<string, unknown> {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}
