import type { AddressInfo } from "node:net";

import { IdentityService, type IdentityOptions } from "../identity/service.ts";
import type { PairingCodeView } from "../identity/pairing.ts";
import type { ComposedServer, ServerComposition } from "./server.ts";
import { composeServer } from "./server.ts";
import { missionPort } from "./missions.ts";
import type { MissionRuntime } from "../missions/runtime.ts";

export interface ListenOptions {
  /** Defaults to loopback. A public bind is a deliberate act, not a default. */
  readonly host?: string;
  /** 0 asks the OS for a free port, which is what a test wants. */
  readonly port?: number;
}

export interface StartedServer {
  readonly server: ComposedServer;
  readonly identity: IdentityService;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** The code to show in the local terminal, and nowhere else. */
  readonly pairing: PairingCodeView;
  shutdown(): Promise<void>;
}

export interface StartOptions extends Omit<ServerComposition, "identity" | "missions"> {
  readonly runtime: MissionRuntime;
  readonly identity?: IdentityService;
  readonly identityOptions?: IdentityOptions;
  readonly listen?: ListenOptions;
  /** Where the pairing code is printed. Defaults to stdout, which on a
   * desktop is the terminal the person started the server in. */
  readonly printPairingCode?: (view: PairingCodeView) => void;
}

/** Brings up the server: one identity service, one composition, one socket on
 * loopback. The pairing code is printed here and never logged, so it exists in
 * the terminal and in the pairing response, and nowhere else. */
export async function startServer(options: StartOptions): Promise<StartedServer> {
  const identity =
    options.identity ??
    new IdentityService({
      ...options.identityOptions,
      ...(options.now !== undefined ? { clock: { now: () => Date.parse(options.now!()) } } : {}),
    });
  const server = composeServer({ ...options, missions: missionPort(options.runtime), identity });
  const host = options.listen?.host ?? "127.0.0.1";
  const port = options.listen?.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => reject(error);
    server.layer.server.once("error", onError);
    server.layer.server.listen(port, host, () => {
      server.layer.server.off("error", onError);
      resolve();
    });
  });

  const address = server.layer.server.address() as AddressInfo | null;
  const boundPort = address?.port ?? port;
  const pairing = identity.issuePairingCode();
  (options.printPairingCode ?? printPairing)(pairing);

  return {
    server,
    identity,
    host,
    port: boundPort,
    url: `http://${formatHost(host)}:${boundPort}`,
    pairing,
    async shutdown() {
      await server.shutdown();
    },
  };
}

function printPairing(view: PairingCodeView): void {
  const minutes = Math.max(1, Math.round((view.expiresAt - Date.now()) / 60_000));
  process.stdout.write(
    [
      "",
      "  Pair a device with this code:",
      "",
      `      ${view.code}`,
      "",
      `  It works once and expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      "",
    ].join("\n"),
  );
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
