// The bridge every platform shares: an inbound queue that survives a restart, an outbox flush that never
// acks what it did not send, and a board built from one contract.
//
// A platform supplies three things and nothing else: its name, a transport line, and a `desk` describing its
// own business (knowledge base, rules, high-impact actions, capability list). The queueing, the retry rules,
// the daily limits and the audit trail are written once here, so two platforms cannot drift apart in how they
// treat a message they failed to deliver.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class BridgeError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BridgeError("store-corrupt", `${file.split(/[\\/]/).pop()} is not valid JSON; move it aside to start clean`, false);
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

const MAX_QUEUED_INBOUND = 200;
const MAX_AUDIT = 1_000;

/**
 * @param platform the platform id the host routes on, such as "tieba"
 * @param workDir the plugin's own directory; every file it keeps lives here
 * @param buildTransport `(config) => transport`, called again whenever the config changes
 */
export function createBridge({ platform, workDir, buildTransport, desk, connects = true }) {
  const STATE = join(workDir, `${platform}-bridge-state.json`);
  const AUDIT = join(workDir, `${platform}-audit.json`);
  const QUEUE = join(workDir, `${platform}-actions.json`);

  const status = {
    startedAt: null, mode: null, live: null, connected: false, lastConnectAt: null, lastError: null,
    inboundDelivered: 0, inboundRefused: 0, outboundSent: 0, outboundPending: 0,
    lastInboundAt: null, lastOutboundAt: null, lastSwitch: null, selfCheck: null,
  };

  let transport = null;
  let config = null;
  let closed = false;
  let pollTimer = null;
  let flushingInbound = false;
  let flushingOutbox = false;
  let tickMs = 20_000;
  let dayKey = new Date().toISOString().slice(0, 10);

  const loadState = () => {
    const state = readJson(STATE, null);
    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.inbound)) {
      return { schemaVersion: 1, inbound: [], lastAckedId: null, sent: { day: dayKey, count: 0 } };
    }
    return state;
  };
  const state = loadState();
  if (state.sent?.day !== dayKey) state.sent = { day: dayKey, count: 0 };

  const note = (error) => { status.lastError = String(error instanceof Error ? error.message : error).slice(0, 400); };
  const save = () => writeJson(STATE, state);

  function audit(action, outcome, detail) {
    const log = readJson(AUDIT, null);
    const entries = log && Array.isArray(log.entries) ? log.entries : [];
    entries.push({ id: `${Date.now()}-${entries.length}`, at: new Date().toISOString(), action, outcome, detail: String(detail ?? "").slice(0, 1_000) });
    writeJson(AUDIT, { schemaVersion: 1, entries: entries.slice(-MAX_AUDIT) });
  }

  const headers = () => {
    const sent = { "content-type": "application/json" };
    if (config?.serverToken) sent.authorization = `Bearer ${config.serverToken}`;
    return sent;
  };

  async function deliver(entry) {
    let response;
    try {
      response = await fetch(`${config.serverUrl}/api/platforms/inbound`, {
        method: "POST", headers: headers(), body: JSON.stringify(entry.event), signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      note(error);
      return false;
    }
    if (response.status === 202 || response.status === 200) {
      status.inboundDelivered += 1;
      status.lastInboundAt = new Date().toISOString();
      return true;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 409) {
      // Not consumed: the same event id is safe to send again later.
      note(`inbound refused: ${body?.error ?? response.status}`);
      return false;
    }
    status.inboundRefused += 1;
    note(`inbound rejected (${response.status}): ${body?.error ?? "no detail"}`);
    state.inbound = state.inbound.filter((row) => row.event.eventId !== entry.event.eventId);
    save();
    return true;
  }

  async function flushInbound() {
    if (!connects || !config || flushingInbound) return;
    flushingInbound = true;
    try {
      // A snapshot, because delivering one removes it from the queue the loop walks.
      for (const entry of state.inbound.slice()) {
        if (!await deliver(entry)) break;
        state.inbound = state.inbound.filter((row) => row !== entry);
        save();
      }
    } finally {
      flushingInbound = false;
    }
  }

  async function accept(message) {
    if (!config || !message.text?.trim()) return;
    if (desk.replyCap && state.sent.count >= desk.replyCap()) {
      note("the daily reply limit is reached; the message waits for a person");
      return;
    }
    state.inbound.push({
      at: new Date().toISOString(),
      event: {
        eventId: `${platform}-${message.messageId}`,
        platform,
        accountId: config.accountId,
        conversation: { id: String(message.conversationId), kind: message.conversationKind ?? "direct" },
        sender: { id: String(message.senderId), ...(message.senderName ? { name: String(message.senderName).slice(0, 200) } : {}) },
        receivedAt: message.receivedAt ?? new Date().toISOString(),
        text: String(message.text).slice(0, 20_000),
      },
    });
    if (state.inbound.length > MAX_QUEUED_INBOUND) state.inbound = state.inbound.slice(-MAX_QUEUED_INBOUND);
    save();
    await flushInbound();
  }

  async function ack(ids) {
    const response = await fetch(`${config.serverUrl}/api/platforms/accounts/${config.accountId}/outbox/ack`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ids }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new BridgeError("ack-failed", `the host did not ack the replies (${response.status}): ${body?.error ?? "no detail"}`, true);
    }
  }

  async function flushOutbox() {
    if (!connects || !config || flushingOutbox || !transport) return;
    flushingOutbox = true;
    try {
      const query = state.lastAckedId ? `?since=${encodeURIComponent(state.lastAckedId)}` : "";
      const response = await fetch(`${config.serverUrl}/api/platforms/accounts/${config.accountId}/outbox${query}`, {
        headers: headers(), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        note(`outbox read failed (${response.status})`);
        return;
      }
      const listed = await response.json().catch(() => null);
      const messages = Array.isArray(listed?.messages) ? listed.messages : [];
      status.outboundPending = messages.length;
      if (!messages.length) return;
      const sent = [];
      for (const message of messages) {
        try {
          await transport.send({ conversationId: message.conversationId, conversationKind: message.conversationKind, text: message.text });
          sent.push(message.id);
          status.outboundSent += 1;
          status.lastOutboundAt = new Date().toISOString();
        } catch (error) {
          // Unknown or refused: not acked, so the reply stays in the outbox for a person or a later attempt.
          note(`reply ${message.id} is unresolved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!sent.length) return;
      await ack(sent);
      state.lastAckedId = sent[sent.length - 1];
      save();
      status.outboundPending = Math.max(0, messages.length - sent.length);
    } finally {
      flushingOutbox = false;
    }
  }

  function refresh() {
    const line = transport?.state?.() ?? {};
    status.connected = Boolean(line.connected);
    status.live = line.live ?? line.mode ?? config?.transport ?? null;
    if (line.selfCheck) status.selfCheck = line.selfCheck;
    if (line.lastError) status.lastError = line.lastError;
    if (status.connected && !status.lastConnectAt) status.lastConnectAt = new Date().toISOString();
  }

  function tick() {
    if (closed) return;
    let loaded;
    try {
      loaded = desk.readConfig();
    } catch (error) {
      note(error);
      return;
    }
    if (!loaded) {
      status.lastError = status.lastError ?? "config.json is missing; the plugin has nothing to connect with";
      return;
    }
    const changed = !config || desk.configChanged(config, loaded);
    config = loaded;
    status.mode = loaded.transport ?? null;
    if (loaded.pollMs && loaded.pollMs !== tickMs) {
      tickMs = loaded.pollMs;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(tick, tickMs);
      pollTimer.unref?.();
    }
    if (changed && transport) {
      const previous = transport;
      transport = null;
      void previous.stop().catch(note);
    }
    if (connects && !transport) {
      const started = buildTransport(loaded);
      transport = started;
      void started.start(accept).then(() => { if (transport === started) refresh(); }).catch(note);
    } else if (connects) {
      refresh();
    }
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dayKey) {
      dayKey = today;
      state.sent = { day: today, count: 0 };
      save();
    }
    void flushInbound().then(() => flushOutbox()).catch(note);
  }

  return {
    status,
    state,
    audit,
    get config() { return config; },
    get transport() { return transport; },
    loadAudit: () => readJson(AUDIT, { schemaVersion: 1, entries: [] }).entries ?? [],
    loadQueue: () => {
      const queue = readJson(QUEUE, null);
      return queue && Array.isArray(queue.items) ? queue : { schemaVersion: 1, items: [] };
    },
    saveQueue: (queue) => writeJson(QUEUE, queue),
    start() {
      if (closed) return;
      status.startedAt = new Date().toISOString();
      tick();
      if (!pollTimer) {
        pollTimer = setInterval(tick, tickMs);
        pollTimer.unref?.();
      }
    },
    async stop() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      const running = transport;
      transport = null;
      if (running) await running.stop().catch(note);
    },
    /** Sends one reply now, for an approval a person just gave. */
    async sendNow(message) {
      if (!transport) throw new BridgeError("no-transport", "no transport line is running, so nothing can be sent", true);
      return transport.send(message);
    },
    /** Runs one page action on the line, for a desk that publishes instead of answering. */
    async runPageAction(action, params) {
      if (!transport) throw new BridgeError("no-transport", "no transport line is running", true);
      if (typeof transport.runAction !== "function") throw new BridgeError("no-action", `the running line cannot ${action}`, false);
      return transport.runAction(action, params);
    },
    refresh,
  };
}

/** The board every platform's plugin answers with, from its own desk plus the bridge's live state. */
export function bridgeBoard({ platform, bridge, desk }) {
  const rules = desk.rules();
  const queue = bridge.loadQueue();
  const auditLog = bridge.loadAudit();
  const status = bridge.status;
  const sections = [...desk.sections({ rules, queue, auditLog, status, bridge })];

  if (queue.items.length) {
    sections.push({
      id: "pending-actions",
      kind: "queue",
      title: desk.copy.pendingTitle,
      items: queue.items.slice(-50).map((item) => ({
        id: item.id,
        title: `${desk.actionLabel(item.action)} · ${JSON.stringify(item.params ?? {}).slice(0, 120)}`,
        reason: desk.copy.pendingReason,
        since: item.at,
        tone: "warning",
        actions: [{ id: "approve", label: desk.copy.approve }, { id: "dismiss", label: desk.copy.dismiss }],
      })),
      empty: desk.copy.pendingEmpty,
    });
  }

  if (auditLog.length) {
    sections.push({
      id: "audit",
      kind: "timeline",
      title: desk.copy.auditTitle,
      entries: auditLog.slice(-40).reverse().map((entry) => ({
        id: entry.id,
        at: entry.at,
        title: `${desk.actionLabel(entry.action)} · ${entry.outcome}`,
        detail: entry.detail,
        tone: entry.outcome === "failed" ? "danger" : entry.outcome === "queued" ? "warning" : "normal",
      })),
      empty: desk.copy.auditEmpty,
    });
  }

  return {
    schemaVersion: 1,
    platform,
    generatedAt: new Date().toISOString(),
    account: desk.account({ rules, status, bridge }),
    headline: desk.headline({ rules, status, queue }),
    sections,
    actions: desk.actions({ rules, status, queue, bridge }),
    limits: desk.limits({ rules, status, bridge }),
    capability: desk.capability({ rules, status, bridge }),
  };
}
