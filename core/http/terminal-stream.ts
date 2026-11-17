import type { Duplex } from "node:stream";

import type { RequestContext, RouteResult } from "./context.ts";
import { ApiError, notFound } from "./errors.ts";
import type { DuplexLike, TerminalPort, TerminalStream, TerminalStreamHandler } from "./ports.ts";
import type { Router } from "./router.ts";
import { Opcode, FrameDecoder, FrameError, encodeClose, encodePong, handshakeHeaders } from "./websocket.ts";

export interface TerminalStreamOptions {
  readonly terminals: TerminalPort;
  readonly handler: TerminalStreamHandler;
}

/** `GET /api/v1/terminals/:terminalId/stream` as a WebSocket upgrade.
 *
 * The ticket is checked by the same code that checks a device bearer, and the
 * ticket names both its purpose and its terminal, so a ticket for one terminal
 * cannot open another. Once accepted, the socket is handed to a
 * `TerminalStreamHandler`: what a terminal frame means belongs to the terminal
 * layer, which this module never imports. */
export function registerTerminalStreamRoute(router: Router, options: TerminalStreamOptions): void {
  router.upgradeGet("/api/v1/terminals/:terminalId/stream", "device", (context) =>
    openTerminalStream(context, options),
  );
}

function openTerminalStream(context: RequestContext, options: TerminalStreamOptions): RouteResult {
  const terminalId = context.params.terminalId as string;
  if (!options.terminals.get(terminalId)) throw notFound("no such terminal");
  const caller = context.caller;
  if (!caller) throw new ApiError("unauthenticated", "a session is required", 401);

  const handshake = handshakeHeaders(context.req);
  if (!handshake) throw new ApiError("invalid_request", "not a WebSocket upgrade", 400);

  const socket = context.upgradeSocket;
  if (!socket) throw new ApiError("invalid_request", "no upgrade socket", 400);

  socket.write(`${handshake.headers.join("\r\n")}\r\n\r\n`);
  const stream = options.handler.open({
    terminalId,
    sessionId: caller.sessionId,
    scope: caller.scope,
    socket: socket as unknown as DuplexLike,
  });
  const untrack = context.track(stream);
  pumpFrames(socket, stream, context.upgradeHead, untrack);
  return { status: 101, handled: true };
}

/** Frames a browser sends are whole messages. Close and ping are answered
 * here; everything else goes to the stream, which decides what it means. */
function pumpFrames(socket: Duplex, stream: TerminalStream, head: Uint8Array | undefined, untrack: () => void): void {
  const decoder = new FrameDecoder();
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    stream.close();
    untrack();
  };
  const handle = (chunk: Uint8Array): void => {
    if (closed) return;
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      const code = error instanceof FrameError && error.code === "too_large" ? 1009 : 1002;
      socket.write(encodeClose(code, error instanceof Error ? error.message : "frame error"));
      finish();
      socket.end();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === Opcode.close) {
        socket.write(encodeClose());
        finish();
        socket.end();
        return;
      }
      if (frame.opcode === Opcode.ping) {
        socket.write(encodePong(frame.payload));
        continue;
      }
      if (frame.opcode === Opcode.pong) continue;
      if (frame.opcode === Opcode.text || frame.opcode === Opcode.binary || frame.opcode === Opcode.continuation) {
        stream.receive(frame.payload);
      }
    }
  };

  if (head !== undefined && head.byteLength > 0) handle(head);
  socket.on("data", (chunk: unknown) => handle(chunk as Uint8Array));
  // `end` arrives when the peer half-closes; `close` may come later or, on a
  // reset, only after the handle is gone. Both end the stream once.
  socket.on("end", finish);
  socket.on("close", finish);
  socket.on("error", finish);
}

export type { TerminalStream };
