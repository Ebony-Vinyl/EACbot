import { afterEach, describe, expect, it } from "vitest";

import type { DuplexLike, TerminalStream } from "../http/ports.ts";
import { Opcode } from "../http/websocket.ts";
import type { EnvironmentRecord } from "../environments/types.ts";
import { UNKNOWN_CAPABILITIES } from "../environments/types.ts";
import { HcClient } from "./client.ts";
import { TerminalService } from "./service.ts";
import { TerminalServicePort, TerminalStreams, mayControl, parseControlMessage } from "./stream.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import type { HcClientFactory } from "./service.ts";
import type { Terminal } from "./types.ts";

/** Lets queued timers and pipe reads run. A reconnect is a `setTimeout`, so
 * waiting only on immediates would never reach it. */
const settle = async (turns = 8): Promise<void> => {
  for (let at = 0; at < turns; at += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const KNOWN_HOSTS = "/home/me/.eacbot/known_hosts";

function environmentRecord(): EnvironmentRecord {
  return {
    id: "env-1",
    label: "my laptop",
    host: "10.0.0.5",
    port: 22,
    user: "me",
    knownHostsFile: KNOWN_HOSTS,
    hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    identityFileRef: null,
    status: "online",
    lastSeen: null,
    capabilities: { ...UNKNOWN_CAPABILITIES, homeDir: "/home/me" },
    tools: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };
}

function terminalRecord(address: string, createdMs: number): Terminal {
  return {
    address,
    argv: ["hermes"],
    cwd: "/home/me",
    state: "live",
    created_ms: createdMs,
    screen: "exact",
    cols: 80,
    rows: 24,
    labels: {},
    title: "",
    turn: 0,
  };
}

class FakeHerdr {
  readonly cores: FakeHc[] = [];
  readonly records = new Map<string, Terminal>();
  /** Every channel a `terminal.attach` opened, in order. */
  readonly attachChannels: number[] = [];
  paint: Uint8Array = Buffer.from("paint");
  #nextAddress = 1;
  #nextCreatedMs = 100;

  /** The most recent attach channel, which is the viewer that just attached. */
  get attachChannel(): number {
    return this.attachChannels.at(-1) ?? 0;
  }

  readonly factory: HcClientFactory = ({ plan }) => {
    const fake = this.#core();
    return new HcClient({ plan, spawner: fake.spawner });
  };

  get core(): FakeHc {
    return this.cores.at(-1)!;
  }

  #core(): FakeHc {
    const fake = new FakeHc();
    for (const [address, record] of this.records) fake.terminal(address, { ...record });
    fake.on("call", (call: { id: number | string; method: string; params: Record<string, unknown> }) => {
      switch (call.method) {
        case "events.subscribe":
          fake.answerSubscribe(call);
          return;
        case "terminal.run": {
          const address = `hc-${this.#nextAddress++}`;
          const record = terminalRecord(address, (this.#nextCreatedMs += 10));
          this.records.set(address, record);
          fake.terminal(address, { ...record });
          fake.reply(call, record);
          return;
        }
        case "terminal.get": {
          const record = this.records.get(String(call.params.terminal));
          if (!record) {
            fake.replyError(call, { code: -32000, message: "no such terminal", kind: "not_found" });
            return;
          }
          fake.reply(call, record);
          return;
        }
        case "terminal.attach":
          this.attachChannels.push(fake.answerAttach(call, { paint: this.paint }));
          return;
        case "terminal.kill": {
          const address = String(call.params.terminal);
          const record = this.records.get(address);
          if (!record) {
            fake.replyError(call, { code: -32000, message: "no such terminal", kind: "not_found" });
            return;
          }
          const killed: Terminal = { ...record, state: "finished", reason: "killed", exit_code: 137 };
          this.records.set(address, killed);
          fake.reply(call, killed);
          return;
        }
        default:
          return;
      }
    });
    this.cores.push(fake);
    return fake;
  }
}

/** A browser's socket, as the HTTP layer would hand one over. */
class FakeSocket implements DuplexLike {
  readonly written: Uint8Array[] = [];
  ended = false;
  destroyed: Error | undefined;

  write(chunk: Uint8Array | string): boolean {
    this.written.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  end(): void {
    this.ended = true;
  }

  destroy(error?: Error): void {
    this.ended = true;
    this.destroyed = error;
  }

  on(): unknown {
    return this;
  }

  /** Everything the server wrote, decoded into WebSocket frames. A server
   * frame is never masked, which is the opposite of the browser frames the
   * HTTP layer's own decoder reads. */
  frames(): { opcode: number; text: string; binary: Uint8Array }[] {
    const out: { opcode: number; text: string; binary: Uint8Array }[] = [];
    let buffer = Buffer.alloc(0);
    for (const chunk of this.written) buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    for (;;) {
      if (buffer.length < 2) break;
      const first = buffer[0] as number;
      const second = buffer[1] as number;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) break;
      const payload = buffer.subarray(offset, offset + length);
      out.push({ opcode, text: payload.toString("utf8"), binary: payload });
      buffer = buffer.subarray(offset + length);
    }
    return out;
  }

  json(): Record<string, unknown>[] {
    return this.frames()
      .filter((frame) => frame.opcode === Opcode.text)
      .map((frame) => JSON.parse(frame.text) as Record<string, unknown>);
  }

  binary(): Uint8Array[] {
    return this.frames()
      .filter((frame) => frame.opcode === Opcode.binary)
      .map((frame) => frame.binary);
  }
}

interface Harness {
  readonly herdr: FakeHerdr;
  readonly service: TerminalService;
  readonly streams: TerminalStreams;
  terminalId: string;
  open(viewerId: string, options?: { scope?: string; terminalId?: string }): { stream: TerminalStream; socket: FakeSocket };
}

const open: (() => void)[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!();
});

async function harness(): Promise<Harness> {
  const herdr = new FakeHerdr();
  const environments = new Map([["env-1", environmentRecord()]]);
  const service = new TerminalService({
    environments: { get: (id) => environments.get(id) ?? null },
    client: herdr.factory,
    reconnectDelaysMs: [0],
    now: () => "2026-01-01T00:00:01.000Z",
  });
  open.push(() => service.close());
  const ref = await service.start({ environmentId: "env-1", tool: "hermes", missionId: "m-1", runId: "r-1" });
  await settle();
  const streams = new TerminalStreams({ service });
  const result: Harness = {
    herdr,
    service,
    streams,
    terminalId: ref.id,
    open(viewerId, options = {}) {
      const socket = new FakeSocket();
      const stream = streams.open({
        terminalId: options.terminalId ?? ref.id,
        sessionId: viewerId,
        scope: options.scope ?? "device",
        socket,
      });
      return { stream, socket };
    },
  };
  return result;
}

describe("the browser protocol", () => {
  it("sends ready first, then the paint as binary", async () => {
    const h = await harness();
    const { socket } = h.open("browser");
    await settle();
    const frames = socket.frames();
    expect(frames[0]!.opcode).toBe(Opcode.text);
    expect(JSON.parse(frames[0]!.text)).toEqual({
      type: "ready",
      terminalId: h.terminalId,
      cols: 80,
      rows: 24,
      canControl: true,
    });
    expect(frames[1]!.opcode).toBe(Opcode.binary);
    expect(Buffer.from(frames[1]!.binary).toString()).toBe("paint");
  });

  it("passes program output through as raw bytes, never as JSON", async () => {
    const h = await harness();
    const { socket } = h.open("browser");
    await settle();
    const channel = h.herdr.attachChannel;
    h.herdr.core.streamData(channel, Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x78]));
    await settle();
    const last = socket.binary().at(-1)!;
    expect([...last]).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x78]);
  });

  it("forwards binary input to the core only while the viewer holds control", async () => {
    const h = await harness();
    const { stream, socket } = h.open("browser");
    await settle();
    stream.receive(Buffer.from("ls\n"));
    await settle();
    const channel = h.herdr.attachChannel;
    const data = h.herdr.core.framesIn.filter((frame) => frame.channel === channel && frame.kind === 0);
    expect(data.at(-1)?.payload.toString()).toBe("ls\n");
    expect(socket.json()).toHaveLength(1);
  });

  it("returns credit to the core for bytes the viewer consumed", async () => {
    const h = await harness();
    const { stream } = h.open("browser");
    await settle();
    const channel = h.herdr.attachChannel;
    h.herdr.core.streamData(channel, Buffer.from("0123456789"));
    await settle();
    stream.receive(Buffer.from(JSON.stringify({ type: "credit", bytes: 10 })));
    await settle();
    expect(h.herdr.core.credited(channel)).toBe(10);
  });

  it("never credits more than it sent, so a viewer cannot inflate the window", async () => {
    const h = await harness();
    const { stream } = h.open("browser");
    await settle();
    const channel = h.herdr.attachChannel;
    h.herdr.core.streamData(channel, Buffer.from("abc"));
    await settle();
    stream.receive(Buffer.from(JSON.stringify({ type: "credit", bytes: 1_000_000 })));
    stream.receive(Buffer.from(JSON.stringify({ type: "credit", bytes: 1_000_000 })));
    await settle();
    // The 5-byte paint plus 3 bytes of output; nothing beyond what was sent.
    expect(h.herdr.core.credited(channel)).toBe(8);
  });

  it("resizes the native terminal when the viewer asks", async () => {
    const h = await harness();
    const { stream } = h.open("browser");
    await settle();
    stream.receive(Buffer.from(JSON.stringify({ type: "resize", cols: 132, rows: 43 })));
    await settle();
    const resize = h.herdr.core.framesIn.find((frame) => frame.kind === 3)!;
    expect(resize.payload.readUInt16LE(0)).toBe(132);
    expect(resize.payload.readUInt16LE(2)).toBe(43);
  });

  it("refuses a bad size with an error frame rather than a crash", async () => {
    const h = await harness();
    const { stream, socket } = h.open("browser");
    await settle();
    stream.receive(Buffer.from(JSON.stringify({ type: "resize", cols: 0, rows: 24 })));
    await settle();
    expect(socket.json().at(-1)).toMatchObject({ type: "error", code: "invalid_params" });
  });

  it("closes the viewer's stream when the browser sends close", async () => {
    const h = await harness();
    const { stream } = h.open("browser");
    await settle();
    stream.receive(Buffer.from(JSON.stringify({ type: "close" })));
    await settle();
    expect(h.service.list()[0]?.closedAt).toBeUndefined();
  });

  it("holds input that arrives before ready and then delivers it", async () => {
    const h = await harness();
    const { stream } = h.open("browser");
    stream.receive(Buffer.from("early"));
    await settle();
    const channel = h.herdr.attachChannel;
    const data = h.herdr.core.framesIn.filter((frame) => frame.channel === channel && frame.kind === 0);
    expect(data.map((frame) => frame.payload.toString()).join("")).toBe("early");
  });
});

describe("observe viewers", () => {
  it("may watch but not type, and says so once", async () => {
    const h = await harness();
    const controller = h.open("laptop");
    await settle();
    const observer = h.open("phone", { scope: "readonly" });
    await settle();
    const ready = observer.socket.json()[0]!;
    expect(ready).toMatchObject({ type: "ready", canControl: false });

    observer.stream.receive(Buffer.from("rm -rf\n"));
    observer.stream.receive(Buffer.from("again\n"));
    await settle();
    const errors = observer.socket.json().filter((message) => message.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "not_controller" });

    const channel = h.herdr.attachChannel;
    const typed = h.herdr.core.framesIn.filter((frame) => frame.channel === channel && frame.kind === 0);
    expect(typed.map((frame) => frame.payload.toString()).join("")).not.toContain("rm -rf");
    controller.stream.receive(Buffer.from("ok\n"));
    await settle();
    expect(h.herdr.core.framesIn.some((frame) => frame.payload.toString() === "ok\n")).toBe(true);
  });

  it("refuses a resize from an observer", async () => {
    const h = await harness();
    const controller = h.open("laptop");
    await settle();
    const observer = h.open("phone", { scope: "readonly" });
    await settle();
    observer.stream.receive(Buffer.from(JSON.stringify({ type: "resize", cols: 100, rows: 40 })));
    await settle();
    expect(observer.socket.json().at(-1)).toMatchObject({ type: "error", code: "not_controller" });
    expect(h.herdr.core.framesIn.some((frame) => frame.kind === 3)).toBe(false);
    void controller;
  });

  it("lets a readonly session watch a terminal that exists", async () => {
    const h = await harness();
    const { socket } = h.open("reader", { scope: "readonly" });
    await settle();
    expect(socket.json()[0]).toMatchObject({ type: "ready", canControl: false });
  });

  it("decides control from the scope, not from what the browser claims", () => {
    expect(mayControl("device", false)).toBe(true);
    expect(mayControl("owner", false)).toBe(true);
    expect(mayControl("readonly", false)).toBe(false);
    expect(mayControl("device", true)).toBe(false);
    expect(mayControl("nonsense", false)).toBe(false);
  });
});

describe("several viewers on one terminal", () => {
  it("gives control to one viewer and observing to the rest", async () => {
    const h = await harness();
    const first = h.open("laptop");
    await settle();
    const second = h.open("phone");
    await settle();
    expect(first.socket.json()[0]).toMatchObject({ canControl: true });
    expect(second.socket.json()[0]).toMatchObject({ canControl: true });
    expect(h.herdr.core.callsOf("terminal.attach")).toHaveLength(2);
    expect(h.herdr.core.callsOf("terminal.attach").map((call) => call.params.observe)).toEqual([false, false]);
  });

  it("keeps both viewers' paints and lets the last controller type", async () => {
    const h = await harness();
    const first = h.open("laptop");
    await settle();
    const second = h.open("phone");
    await settle();
    expect(first.socket.binary()).toHaveLength(1);
    expect(second.socket.binary()).toHaveLength(1);
    first.stream.receive(Buffer.from("first\n"));
    await settle();
    const channel = h.herdr.attachChannel;
    expect(h.herdr.core.framesIn.filter((frame) => frame.channel === channel && frame.kind === 0)).toHaveLength(0);
    second.stream.receive(Buffer.from("second\n"));
    await settle();
    expect(h.herdr.core.framesIn.some((frame) => frame.payload.toString() === "second\n")).toBe(true);
  });

  it("does not take the other viewer's stream down when one closes", async () => {
    const h = await harness();
    const first = h.open("laptop");
    await settle();
    const second = h.open("phone", { scope: "readonly" });
    await settle();
    first.stream.close();
    await settle();
    expect(second.socket.ended).toBe(false);
  });
});

describe("reconnecting", () => {
  it("tells the viewer to resync when the line drops, and attaches again on a new socket", async () => {
    const h = await harness();
    const first = h.open("browser");
    await settle();
    h.herdr.core.crash();
    await settle(30);

    expect(first.socket.json().at(-1)).toMatchObject({ type: "resync", reason: "disconnected" });
    expect(first.socket.ended).toBe(true);

    h.herdr.paint = Buffer.from("fresh paint");
    const second = h.open("browser");
    await settle();
    const ready = second.socket.json()[0]!;
    expect(ready).toMatchObject({ type: "ready" });
    expect(Buffer.from(second.socket.binary()[0]!).toString()).toBe("fresh paint");
  });

  it("reports an exit when the core lost the terminal, never a fake paint", async () => {
    const h = await harness();
    const first = h.open("browser");
    await settle();
    h.herdr.records.clear();
    h.herdr.core.crash();
    await settle(30);

    expect(first.socket.json().find((message) => message.type === "resync")).toBeDefined();
    expect(h.service.get(h.terminalId)?.closedAt).toBeDefined();
    const second = h.open("browser");
    await settle();
    expect(second.socket.json()[0]).toMatchObject({ type: "error", code: "closed" });
  });

  it("reports an exit when the program itself ends", async () => {
    const h = await harness();
    const { socket } = h.open("browser");
    await settle();
    h.herdr.core.emitEvent("finished", "hc-1", { reason: "exited", exit_code: 0 });
    await settle();
    expect(socket.json().at(-1)).toMatchObject({ type: "exit", reason: "exited", exitCode: 0 });
  });
});

describe("title and status", () => {
  it("forwards a title and a status to every viewer of that terminal", async () => {
    const h = await harness();
    const first = h.open("laptop");
    await settle();
    const second = h.open("phone", { scope: "readonly" });
    await settle();
    h.herdr.core.emitEvent("title", "hc-1", { title: "hermes — build" });
    h.herdr.core.emitEvent("status", "hc-1", { status: { state: "working" } });
    await settle();
    for (const socket of [first.socket, second.socket]) {
      const messages = socket.json();
      expect(messages.find((message) => message.type === "title")).toEqual({ type: "title", title: "hermes — build" });
      expect(messages.find((message) => message.type === "status")).toEqual({
        type: "status",
        status: { state: "working" },
      });
    }
  });
});

describe("failures", () => {
  it("reports an unknown terminal as an error and ends the socket", async () => {
    const h = await harness();
    const { socket } = h.open("browser", { terminalId: "nope" });
    await settle();
    expect(socket.json()[0]).toMatchObject({ type: "error", code: "unknown_terminal" });
    expect(socket.ended).toBe(true);
  });

  it("reports a closed terminal rather than attaching to it", async () => {
    const h = await harness();
    const { socket } = h.open("browser");
    await settle();
    await h.service.kill(h.terminalId);
    const second = h.open("browser");
    await settle();
    expect(second.socket.json()[0]).toMatchObject({ type: "error", code: "closed" });
    void socket;
  });
});

describe("control message parsing", () => {
  it("reads the three control types and nothing else", () => {
    expect(parseControlMessage(Buffer.from('{"type":"resize","cols":80,"rows":24}'))).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });
    expect(parseControlMessage(Buffer.from('{"type":"credit","bytes":5}'))).toEqual({ type: "credit", bytes: 5 });
    expect(parseControlMessage(Buffer.from('{"type":"close"}'))).toEqual({ type: "close" });
    expect(parseControlMessage(Buffer.from("hello"))).toBeNull();
    expect(parseControlMessage(Buffer.from('{"type":"nope"}'))).toBeNull();
    expect(parseControlMessage(Buffer.from('{"not":"a control"}'))).toBeNull();
    expect(parseControlMessage(Buffer.from("\u001b[31m"))).toBeNull();
  });

  it("treats a JSON-looking keystroke that is not a control message as input", async () => {
    const h = await harness();
    const { stream } = h.open("browser");
    await settle();
    stream.receive(Buffer.from('{"type":"unknown"}'));
    await settle();
    const channel = h.herdr.attachChannel;
    const data = h.herdr.core.framesIn.filter((frame) => frame.channel === channel && frame.kind === 0);
    expect(data.at(-1)?.payload.toString()).toBe('{"type":"unknown"}');
  });
});

describe("the terminal port", () => {
  it("lists and reads the same references the service does", async () => {
    const h = await harness();
    const port = new TerminalServicePort(h.service);
    expect(port.list()).toEqual(h.service.list());
    expect(port.get(h.terminalId)).toEqual(h.service.get(h.terminalId));
    expect(port.get("nope")).toBeUndefined();
  });
});
