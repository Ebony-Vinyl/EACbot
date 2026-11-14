// What a Xianyu transport must do, whichever way it reaches the platform.
//
// Two lines implement this: the protocol line speaks to the platform's own gateway, the web line drives the
// signed-in pages in a browser. Everything above this file — the inbox queue, the reply flush, the knowledge
// base, the rules, the board — is written once and cannot tell which line is running. A line that stops working
// fails visibly through `state()`; it never answers as though it had delivered something.
//
// Licence note: the protocol line implements interfaces observed in public traffic. The reference projects this
// feature was requested from are AGPL-3.0 with a non-commercial clause (xianyu-auto-reply) or carry no licence
// (xyxyxy), so no code was copied from them; only the endpoint shapes and field names they document are used.

export const TRANSPORT_MODES = ["protocol", "web", "auto"];

/** Why a line could not do its job. The board shows these codes as-is. */
export class TransportError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A transport's public surface.
 *
 * `start` opens the line and calls `onEvent` with each normalized message; `send` delivers one reply and
 * resolves only once the platform accepted it; `state` reports what the line is doing right now.
 */
export function assertTransport(transport, name = "transport") {
  for (const method of ["start", "stop", "send", "state"]) {
    if (typeof transport?.[method] !== "function") throw new TypeError(`${name} is missing ${method}()`);
  }
  return transport;
}

/**
 * The event every line produces, before the host sees it. Fields map one-to-one onto the host's inbound
 * contract; `eventId` must be stable for a message so a retry cannot deliver it twice.
 */
export function inboundEvent({ platform, accountId, conversationId, conversationKind, senderId, senderName, text, messageId, receivedAt, replyTo }) {
  return {
    eventId: `${platform}-${messageId}`,
    platform,
    accountId,
    conversation: { id: String(conversationId), kind: conversationKind ?? "direct" },
    sender: { id: String(senderId), ...(senderName ? { name: String(senderName).slice(0, 200) } : {}) },
    receivedAt: receivedAt ?? new Date().toISOString(),
    ...(text ? { text: String(text).slice(0, 20_000) } : {}),
    ...(replyTo ? { replyTo: String(replyTo) } : {}),
  };
}

/**
 * Runs two lines as one. The first is primary; when it reports itself down the second takes over, and the
 * handover is announced through `onSwitch` so the board can say which line answered last.
 */
export function createFailoverTransport({ primary, fallback, onSwitch }) {
  let active = null;
  let lastSwitch = null;

  const pick = () => {
    const primaryState = primary?.state();
    if (primaryState?.connected) return primary;
    const fallbackState = fallback?.state();
    if (fallbackState?.connected) return fallback;
    return primaryState && !primaryState.fatal ? primary : fallback;
  };

  const engage = (next) => {
    if (!next || next === active) return active;
    const previous = active;
    active = next;
    if (previous && next !== previous) {
      lastSwitch = { at: new Date().toISOString(), from: previous.name ?? "primary", to: next.name ?? "fallback" };
      onSwitch?.(lastSwitch);
    }
    return active;
  };

  return {
    name: "auto",
    async start(onEvent) {
      await primary?.start(onEvent);
      await fallback?.start(onEvent);
      engage(pick());
    },
    async stop() {
      await primary?.stop();
      await fallback?.stop();
    },
    async send(message) {
      const line = engage(pick());
      if (!line) throw new TransportError("no-transport", "Neither the protocol line nor the web line is available.", false);
      try {
        return await line.send(message);
      } catch (error) {
        // A primary that dies mid-send leaves the result unknown: the reply stays unacked and the next pass
        // uses whichever line is up, so the same message is never sent twice by the same line.
        if (error?.retryable && fallback && line === primary && fallback.state()?.connected) {
          lastSwitch = { at: new Date().toISOString(), from: "protocol", to: "web" };
          onSwitch?.(lastSwitch);
          return fallback.send(message);
        }
        throw error;
      }
    },
    state() {
      const primaryState = primary?.state() ?? { connected: false };
      const fallbackState = fallback?.state() ?? { connected: false };
      const line = engage(pick());
      return {
        mode: "auto",
        connected: Boolean(primaryState.connected || fallbackState.connected),
        live: line === primary ? "protocol" : line === fallback ? "web" : "none",
        protocol: primaryState.connected ? "up" : primaryState.fatal ? "failed" : "down",
        web: fallbackState.connected ? "up" : fallbackState.fatal ? "failed" : "down",
        lastSwitch,
        lastError: primaryState.lastError ?? fallbackState.lastError ?? null,
      };
    },
  };
}
