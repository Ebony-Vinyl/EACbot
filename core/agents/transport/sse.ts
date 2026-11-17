/** Server-sent events, parsed by the spec's field rules. Used by the HTTP agents (OpenCode and
 * Hermes), whose event streams are the only live channel either offers. */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Incremental parser: feed it text as it arrives, receive whole messages. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;
  private readonly onMessage: (message: SseMessage) => void;

  constructor(onMessage: (message: SseMessage) => void) {
    this.onMessage = onMessage;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.search(/\r\n|\n|\r/);
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      const width = this.buffer.startsWith("\r\n", index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + width);
      this.line(line);
      index = this.buffer.search(/\r\n|\n|\r/);
    }
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        this.id = value;
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    if (this.data.length === 0 && this.event === "") return;
    const message: SseMessage = { event: this.event || "message", data: this.data.join("\n") };
    if (this.id !== undefined) message.id = this.id;
    this.event = "";
    this.data = [];
    this.id = undefined;
    this.onMessage(message);
  }
}

/** Reads a `fetch` response body as SSE until the stream ends or `signal` aborts. */
export async function readSse(
  response: Response,
  onMessage: (message: SseMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onMessage);
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A stream the server already closed is not an error worth surfacing.
    }
  }
}

/** JSON payload of a message, or null when the engine sent something that is not JSON. */
export function sseJson(message: SseMessage): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(message.data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
