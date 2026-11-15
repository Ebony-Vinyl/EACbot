/** Holds one terminal connection per terminal the panes show, with the lease
 * beside it.
 *
 * A connection lives exactly as long as a pane shows it: the registry opens
 * what the panes need and closes the rest. The lease is kept here rather than
 * in a pane, so re-rendering or re-splitting cannot lose who may type.
 *
 * Watching and controlling are two separate facts, and both must be true
 * before a keystroke leaves this module. Watching is the default. Taking
 * control is a person's explicit act, and the server's `canControl` grant is
 * still required: a person who asks for a terminal someone else holds is told
 * so instead of being given input that would go nowhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { initialLease, reduceLease, type LeaseState } from "./control-lease.ts";
import {
  createTerminalConnection,
  type FoundationConnect,
  type LeaseRole,
  type TerminalConnection,
} from "./terminal-transport.ts";

export interface TerminalBinding {
  readonly connection: TerminalConnection;
  readonly lease: LeaseState;
}

export interface TerminalRegistryOptions {
  readonly wanted: readonly string[];
  readonly connect?: FoundationConnect;
}

export interface TerminalRegistry {
  readonly bindings: Readonly<Record<string, TerminalBinding>>;
  acquire(terminalId: string): void;
  release(terminalId: string): void;
  retry(terminalId: string): void;
}

/**
 * The lease a stream state implies. `requested` is whether a person asked for
 * control; the server's grant is the other half, so a live stream that says
 * `canControl` grants it and one that does not says who does instead. A
 * person's request outlives a reconnect, so the reattached stream grants again
 * without another click.
 */
export function leaseAfterStream(
  kind: string,
  canControl: boolean,
  current: LeaseState,
  requested: boolean,
  now = Date.now(),
): LeaseState {
  if (kind === "live") {
    if (!requested) return current.kind === "controlling" ? reduceLease(current, { type: "release" }) : current;
    return canControl
      ? { kind: "controlling", since: now }
      : { kind: "held-by-other", holder: "Another viewer" };
  }
  if (kind === "reconnecting") {
    return current.kind === "controlling" || current.kind === "requesting"
      ? { kind: "requesting" }
      : current;
  }
  if (kind === "closed" || kind === "exited") {
    return current.kind === "controlling" ? reduceLease(current, { type: "release" }) : current;
  }
  return current;
}

export function useTerminalRegistry(options: TerminalRegistryOptions): TerminalRegistry {
  const { wanted, connect } = options;
  const [bindings, setBindings] = useState<Record<string, TerminalBinding>>({});
  const leases = useRef(new Map<string, LeaseState>());
  const wants = useRef(new Set<string>());
  const connections = useRef(new Map<string, TerminalConnection>());
  const wantedKey = wanted.join("\u0000");

  const publish = useCallback((terminalId: string, lease: LeaseState): void => {
    leases.current.set(terminalId, lease);
    setBindings((all) => {
      const entry = all[terminalId];
      return entry ? { ...all, [terminalId]: { ...entry, lease } } : all;
    });
  }, []);

  useEffect(() => {
    const keep = new Set(wanted);
    const removed = [...connections.current.keys()].filter((terminalId) => !keep.has(terminalId));
    for (const terminalId of removed) {
      connections.current.get(terminalId)?.close();
      connections.current.delete(terminalId);
      leases.current.delete(terminalId);
      wants.current.delete(terminalId);
    }

    const added = wanted.filter((terminalId) => !connections.current.has(terminalId));
    for (const terminalId of added) {
      const lease = leases.current.get(terminalId) ?? initialLease();
      leases.current.set(terminalId, lease);
      const connection = createTerminalConnection({
        terminalId,
        getRole: (): LeaseRole => (wants.current.has(terminalId) ? "control" : "observe"),
        ...(connect !== undefined ? { connect } : {}),
      });
      connection.onEvent((event) => {
        if (event.type !== "state") return;
        const current = leases.current.get(terminalId) ?? initialLease();
        const next = leaseAfterStream(
          event.state.kind,
          event.state.kind === "live" ? event.state.canControl : false,
          current,
          wants.current.has(terminalId),
        );
        if (next === current) return;
        publish(terminalId, next);
      });
      connection.open();
      connections.current.set(terminalId, connection);
    }

    if (removed.length > 0 || added.length > 0) {
      const next: Record<string, TerminalBinding> = {};
      for (const [terminalId, connection] of connections.current) {
        next[terminalId] = { connection, lease: leases.current.get(terminalId) ?? initialLease() };
      }
      setBindings(next);
    }
    return undefined;
  }, [wantedKey, connect, publish]);

  useEffect(() => () => {
    for (const connection of connections.current.values()) connection.close();
    connections.current.clear();
    leases.current.clear();
    wants.current.clear();
  }, []);

  const acquire = useCallback((terminalId: string): void => {
    const connection = connections.current.get(terminalId);
    if (!connection) return;
    wants.current.add(terminalId);
    publish(terminalId, reduceLease(leases.current.get(terminalId) ?? initialLease(), { type: "request" }));
    // The server grants control with `ready`, so this reads the grant the live
    // stream already holds rather than reattaching: the screen the person was
    // reading stays where it is.
    if (connection.state.kind !== "live") return;
    publish(terminalId, leaseAfterStream("live", connection.canControl, leases.current.get(terminalId) ?? initialLease(), true));
  }, [publish]);

  const release = useCallback((terminalId: string): void => {
    wants.current.delete(terminalId);
    publish(terminalId, reduceLease(leases.current.get(terminalId) ?? initialLease(), { type: "release" }));
  }, [publish]);

  const retry = useCallback((terminalId: string): void => {
    connections.current.get(terminalId)?.retry();
  }, []);

  return useMemo(() => ({ bindings, acquire, release, retry }), [bindings, acquire, release, retry]);
}
