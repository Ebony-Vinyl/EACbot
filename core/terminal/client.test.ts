import { describe, expect, it } from "vitest";

import { HcClient } from "./client.ts";
import { TransportError } from "./protocol.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import { FrameKind, encodeFrame } from "./wire.ts";
import type { Terminal } from "./types.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function terminal(address: string, overrides: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["sh"],
    cwd: "/home/me",
    state: "live",
    created_ms: 1,
    screen: "exact",
    cols: 80,
    rows: 24,
    labels: {},
    title: "",
    turn: 0,
    ...overrides,
  };
}

async function client(options: { framed?: boolean } = {}) {
  const fake = new FakeHc();
  const hc = new HcClient({
    transport: { kind: "local" },
    spawner: fake.spawner,
  });
  await hc.connect({ framed: options.framed ?? true });
  return { fake, hc };
}

describe("connecting", () => {
  it("plans a local hc connect and hands it to the spawner unchanged", async () => {
    const fake = new FakeHc();
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect();
    expect(fake.plan).toMatchObject({ command: "herdr-core", args: ["connect"] });
    expect(fake.spawnOptions).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] });
    hc.close();
  });

  it("plans ssh hc connect for a remote core", async () => {
    const fake = new FakeHc();
    const hc = new HcClient({
      transport: { kind: "ssh", host: "rohan", user: "me", knownHostsFile: "/var/lib/eacbot/known_hosts" },
      spawner: fake.spawner,
    });
    await hc.connect();
    expect(fake.plan?.command).toBe("ssh");
    expect(fake.plan?.args[0]).toBe("-T");
    expect(fake.plan?.args.at(-2)).toBe("rohan");
    expect(fake.plan?.connect).toMatchObject({ kind: "ssh", host: "rohan", user: "me", batchMode: true });
    hc.close();
  });

  it("frames the connection so attach and events work", async () => {
    const { hc } = await client();
    expect(hc.connection.mode).toBe("framed");
    expect(hc.hello?.generation).toBe(1);
    hc.close();
  });
});

describe("terminal operations", () => {
  it("runs a program with the fields the OpenRPC document names", async () => {
    const { fake, hc } = await client();
    const running = hc.run({ argv: ["claude"], cwd: "/srv/app", name: "work", keep: true, labels: { team: "a" } });
    await settle();
    expect(fake.call("terminal.run")?.params).toEqual({
      argv: ["claude"],
      cwd: "/srv/app",
      name: "work",
      keep: true,
      labels: { team: "a" },
    });
    fake.reply(fake.call("terminal.run")!, {
      ...terminal("t1"),
      address: "t1",
      argv: ["claude"],
      cwd: "/srv/app",
      name: "work",
    });
    await expect(running).resolves.toMatchObject({ address: "t1", name: "work" });
    hc.close();
  });

  it("sends only the run fields the caller set, so the core keeps its defaults", async () => {
    const { fake, hc } = await client();
    const running = hc.run({ argv: ["sh"], cwd: null });
    await settle();
    const params = fake.call("terminal.run")!.params;
    expect(params).toEqual({ argv: ["sh"], cwd: null });
    expect("size" in params).toBe(false);
    expect("name" in params).toBe(false);
    fake.reply(fake.call("terminal.run")!, terminal("t1"));
    await running;
    hc.close();
  });

  it("sends every documented run field with the name the OpenRPC document uses", async () => {
    const { fake, hc } = await client();
    const running = hc.run({
      argv: ["claude", "--resume"],
      name: "work",
      cwd: "/srv/app",
      env: { EDITOR: "vim", TERM_PROGRAM: "eacbot" },
      keep: true,
      size: { cols: 200, rows: 120 },
      display: { bg: "#101010", fg: "#f0f0f0", cursor: "#ffffff", cell: [9, 18] },
      labels: { team: "a", role: "worker" },
      parent: "t1",
      no_parent: false,
      no_notify: true,
      outlive_parent: true,
      rm: true,
      wait: false,
      timeout: 30,
      on: "rohan",
      caller: "t1",
    });
    await settle();
    expect(fake.call("terminal.run")!.params).toEqual({
      argv: ["claude", "--resume"],
      name: "work",
      cwd: "/srv/app",
      env: { EDITOR: "vim", TERM_PROGRAM: "eacbot" },
      keep: true,
      size: { cols: 200, rows: 120 },
      display: { bg: "#101010", fg: "#f0f0f0", cursor: "#ffffff", cell: [9, 18] },
      labels: { team: "a", role: "worker" },
      parent: "t1",
      no_parent: false,
      no_notify: true,
      outlive_parent: true,
      rm: true,
      wait: false,
      timeout: 30,
      on: "rohan",
      caller: "t1",
    });
    fake.reply(fake.call("terminal.run")!, terminal("t1"));
    await running;
    hc.close();
  });

  it("runs a shell line instead of an argv", async () => {
    const { fake, hc } = await client();
    const running = hc.run({ line: "cd /srv/app && make" });
    await settle();
    expect(fake.call("terminal.run")!.params).toEqual({ line: "cd /srv/app && make" });
    fake.reply(fake.call("terminal.run")!, terminal("t1"));
    await running;
    hc.close();
  });

  it("refuses an initial size the core would reject", async () => {
    const { hc } = await client();
    await expect(hc.run({ argv: ["sh"], size: { cols: 0, rows: 24 } })).rejects.toBeInstanceOf(TransportError);
    await expect(hc.run({ argv: ["sh"], size: { cols: 80, rows: 65_536 } })).rejects.toBeInstanceOf(TransportError);
    await expect(hc.run({ argv: ["sh"], size: { cols: 80.5, rows: 24 } })).rejects.toBeInstanceOf(TransportError);
    hc.close();
  });

  it("lists with all and labels", async () => {
    const { fake, hc } = await client();
    const listing = hc.list({ all: true, labels: { team: "a" } });
    await settle();
    expect(fake.call("terminal.list")?.params).toEqual({ all: true, labels: { team: "a" } });
    fake.answerList(fake.call("terminal.list")!);
    await expect(listing).resolves.toMatchObject({ hidden_finished: 0 });
    hc.close();
  });

  it("sends text with force and the status precondition", async () => {
    const { fake, hc } = await client();
    const sent = hc.send({ terminal: "t1", text: "continue", force: true, if: "idle" });
    await settle();
    expect(fake.call("terminal.send")?.params).toEqual({ terminal: "t1", text: "continue", force: true, if: "idle" });
    fake.reply(fake.call("terminal.send")!, { turn: 3, started: true });
    await expect(sent).resolves.toEqual({ turn: 3, started: true });
    hc.close();
  });

  it("interrupts and reports what the core observed", async () => {
    const { fake, hc } = await client();
    const interrupting = hc.interrupt("t1", 5);
    await settle();
    expect(fake.call("terminal.interrupt")?.params).toEqual({ terminal: "t1", timeout: 5 });
    fake.reply(fake.call("terminal.interrupt")!, { outcome: "still_working", key: "esc" });
    await expect(interrupting).resolves.toEqual({ outcome: "still_working", key: "esc" });
    hc.close();
  });

  it("kills, keeps and gets with the terminal address", async () => {
    const { fake, hc } = await client();
    const killing = hc.kill("rohan/t7");
    await settle();
    expect(fake.call("terminal.kill")?.params).toEqual({ terminal: "rohan/t7" });
    fake.reply(fake.call("terminal.kill")!, terminal("rohan/t7", { state: "finished" }));
    await expect(killing).resolves.toMatchObject({ state: "finished" });

    const keeping = hc.keep("t1", true);
    await settle();
    expect(fake.call("terminal.keep")?.params).toEqual({ terminal: "t1", keep: true });
    fake.reply(fake.call("terminal.keep")!, terminal("t1", { keep: true }));
    await expect(keeping).resolves.toMatchObject({ keep: true });

    const getting = hc.get("t1");
    await settle();
    expect(fake.call("terminal.get")?.params).toEqual({ terminal: "t1" });
    fake.reply(fake.call("terminal.get")!, terminal("t1"));
    await expect(getting).resolves.toMatchObject({ address: "t1" });
    hc.close();
  });

  it("surfaces a not_found from the core instead of inventing a terminal", async () => {
    const { fake, hc } = await client();
    const getting = hc.get("t9");
    await settle();
    fake.replyError(fake.call("terminal.get")!, { code: -32000, message: "no terminal t9", kind: "not_found" });
    await expect(getting).rejects.toMatchObject({ kind: "not_found" });
    hc.close();
  });
});

describe("attach through the client", () => {
  it("opens a stream, feeds the first paint, and detaches with CLOSE", async () => {
    const { fake, hc } = await client();
    const opening = hc.attach({ terminal: "t1", cols: 100, rows: 30, history: 200 });
    await settle();
    const channel = fake.answerAttach(fake.call("terminal.attach")!, { paint: Buffer.from("$ ") });
    const stream = await opening;
    const seen: string[] = [];
    stream.on("data", (bytes) => seen.push(Buffer.from(bytes).toString()));
    // The paint was sent with the reply, before the sink existed.
    expect(seen.join("")).toBe("$ ");
    expect(channel).toBe(stream.channel);
    await stream.detach();
    expect(fake.framesIn.some((frame) => frame.channel === channel && frame.kind === FrameKind.CLOSE)).toBe(true);
    hc.close();
  });

  it("ends every stream when the connection dies", async () => {
    const { fake, hc } = await client();
    const opening = hc.attach({ terminal: "t1", cols: 80, rows: 24 });
    await settle();
    fake.answerAttach(fake.call("terminal.attach")!);
    const stream = await opening;
    const lost: unknown[] = [];
    stream.on("lost", (error) => lost.push(error));
    fake.crash();
    expect(lost).toHaveLength(1);
    expect(hc.streams).toHaveLength(0);
  });
});

describe("events", () => {
  it("subscribes and takes the snapshot before any event", async () => {
    const fake = new FakeHc();
    fake.terminal("t1", { title: "before" });
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect();
    const subscribing = hc.subscribe({ labels: { team: "a" } });
    await settle();
    expect(fake.call("events.subscribe")?.params).toEqual({ labels: { team: "a" } });
    const channel = fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 7 })!;
    const { result } = await subscribing;
    expect(result.seq).toBe(7);
    expect(hc.registry.list().map((record) => record.address)).toEqual(["t1"]);
    expect(channel).toBeTypeOf("number");
    hc.close();
  });

  it("applies events in order and drops a repeat", async () => {
    const { fake, hc } = await client();
    const subscribing = hc.subscribe();
    await settle();
    const channel = fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 0 })!;
    await subscribing;
    const events: unknown[] = [];
    hc.on("event", (event) => events.push(event));

    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 1, type: "created", terminal: "t7", data: terminal("t7") } }, channel);
    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 1, type: "created", terminal: "t7", data: terminal("t7") } }, channel);
    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 2, type: "title", terminal: "t7", data: { title: "claude" } } }, channel);
    expect(hc.registry.get("t7")?.title).toBe("claude");
    expect(events).toHaveLength(3);
    expect(hc.registry.seq).toBe(2);
    hc.close();
  });

  it("takes a heartbeat without touching terminal facts", async () => {
    const { fake, hc } = await client();
    const subscribing = hc.subscribe();
    await settle();
    const channel = fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 4 })!;
    await subscribing;
    const beats: unknown[] = [];
    hc.on("heartbeat", (params) => beats.push(params));
    fake.sendJson({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 4 } }, channel);
    expect(beats).toEqual([{ seq: 4 }]);
    expect(hc.registry.seq).toBe(4);
    hc.close();
  });

  it("replaces the view from a missed snapshot and ignores the older events", async () => {
    const { fake, hc } = await client();
    const subscribing = hc.subscribe();
    await settle();
    const channel = fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 0 })!;
    await subscribing;
    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 1, type: "created", terminal: "t1", data: terminal("t1") } }, channel);
    expect(hc.registry.get("t1")).not.toBeNull();

    const missed: unknown[] = [];
    hc.on("missed", (params) => missed.push(params));
    fake.sendJson(
      { jsonrpc: "2.0", method: "missed", params: { seq: 57, terminals: [terminal("t2"), terminal("t3")] } },
      channel,
    );
    expect(missed).toHaveLength(1);
    expect(hc.registry.list().map((record) => record.address)).toEqual(["t2", "t3"]);
    expect(hc.registry.seq).toBe(57);

    // A queued event from before the snapshot must not resurrect t1.
    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 50, type: "title", terminal: "t1", data: { title: "old" } } }, channel);
    expect(hc.registry.get("t1")).toBeNull();
    hc.close();
  });

  it("credits the event channel for the bytes it read", async () => {
    const { fake, hc } = await client();
    const subscribing = hc.subscribe();
    await settle();
    const channel = fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 0 })!;
    await subscribing;
    fake.sendJson({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 1 } }, channel);
    await settle();
    expect(fake.credited(channel)).toBeGreaterThan(0);
    hc.close();
  });

  it("reconciles a reconnect from a fresh snapshot and never replays", async () => {
    const fake = new FakeHc();
    fake.terminal("t1");
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect();
    const subscribing = hc.subscribe();
    await settle();
    fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 12 });
    await subscribing;
    expect(hc.registry.get("t1")).not.toBeNull();

    // The line drops. Nothing from before is trusted.
    const disconnected = new Promise((resolve) => hc.once("disconnected", resolve));
    fake.crash("link down");
    await disconnected;
    expect(hc.registry.stale).toBe(true);

    const second = new FakeHc();
    second.terminal("t1", { title: "after" });
    second.terminal("t2");
    const reconnected = new HcClient({ transport: { kind: "local" }, spawner: second.spawner });
    await reconnected.connect();
    const resubscribing = reconnected.subscribe();
    await settle();
    second.answerSubscribe(second.call("events.subscribe")!, { seq: 2 });
    await resubscribing;
    expect(reconnected.registry.list().map((record) => record.title || record.address)).toEqual(["after", "t2"]);
    expect(reconnected.registry.seq).toBe(2);
    hc.close();
    reconnected.close();
  });

  it("reads notifications from a plain-mode subscription", async () => {
    const fake = new FakeHc();
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    await hc.connect({ framed: false });
    const subscribing = hc.subscribe();
    await settle();
    // Plain mode: no channel, and the connection carries only notifications.
    fake.reply(fake.call("events.subscribe")!, { seq: 3, terminals: [terminal("t1")] });
    const { result } = await subscribing;
    expect(result.channel).toBeUndefined();
    expect(hc.registry.get("t1")).not.toBeNull();
    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 4, type: "title", terminal: "t1", data: { title: "plain" } } });
    expect(hc.registry.get("t1")?.title).toBe("plain");
    hc.close();
  });

  it("resync replaces the view without needing a new client", async () => {
    const { fake, hc } = await client();
    const first = hc.subscribe();
    await settle();
    fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 10 });
    await first;
    fake.terminal("t1");
    fake.terminals.get("t1")!.title = "changed";

    const resyncing = hc.resync();
    await settle();
    fake.answerSubscribe(fake.callsOf("events.subscribe").at(-1)!, { seq: 1 });
    await resyncing;
    expect(hc.registry.get("t1")?.title).toBe("changed");
    expect(hc.registry.seq).toBe(1);
    expect(hc.registry.stale).toBe(false);
    hc.close();
  });
});

describe("the terminal layer never writes task state", () => {
  it("exposes no mission, task or agent-record surface", async () => {
    const { hc } = await client();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(hc));
    for (const forbidden of ["mission", "task", "agent", "createTask", "updateMission", "record"]) {
      expect(surface.filter((name) => name.toLowerCase().includes(forbidden.toLowerCase()))).toEqual([]);
    }
    hc.close();
  });

  it("keeps OSC 7501 status as the program reported it", async () => {
    const { fake, hc } = await client();
    const subscribing = hc.subscribe();
    await settle();
    const channel = fake.answerSubscribe(fake.call("events.subscribe")!, { seq: 0 })!;
    await subscribing;
    fake.sendJson({ jsonrpc: "2.0", method: "event", params: { seq: 1, type: "created", terminal: "t1", data: terminal("t1") } }, channel);
    fake.sendJson(
      {
        jsonrpc: "2.0",
        method: "event",
        params: { seq: 2, type: "status", terminal: "t1", data: { status: { state: "needs-a-human", app: "custom" }, records: {}, reported: true } },
      },
      channel,
    );
    expect(hc.registry.get("t1")?.status).toEqual({ state: "needs-a-human", app: "custom" });
    hc.close();
  });
});

describe("server errors", () => {
  it("passes a spawn_failed run error through with its hint", async () => {
    const { fake, hc } = await client();
    const running = hc.run({ argv: ["/missing"] });
    await settle();
    fake.replyError(fake.call("terminal.run")!, {
      code: -32000,
      message: "cannot start /missing",
      kind: "spawn_failed",
      hint: "check the path",
    });
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "spawn_failed", hint: "check the path" });
    hc.close();
  });

  it("passes an unavailable attach error through, as a lost kept terminal reports", async () => {
    const { fake, hc } = await client();
    const opening = hc.attach({ terminal: "t1", cols: 80, rows: 24 });
    await settle();
    fake.replyError(fake.call("terminal.attach")!, {
      code: -32000,
      message: "lost, waiting for its new shell",
      kind: "unavailable",
      hint: "retry after restarted",
    });
    await expect(opening).rejects.toMatchObject({ kind: "unavailable" });
    expect(hc.streams).toHaveLength(0);
    hc.close();
  });

  it("drops a frame on channel 0 that is not JSON instead of guessing", async () => {
    const { fake, hc } = await client();
    const lost: unknown[] = [];
    hc.on("disconnected", (error) => lost.push(error));
    fake.sendFrame(0, FrameKind.DATA, Buffer.from("not json"));
    expect(lost).toHaveLength(1);
    hc.close();
  });
});

describe("frame order", () => {
  it("keeps the attach reply ahead of its first paint when they share a read", async () => {
    const fake = new FakeHc({ silentHello: true });
    const hc = new HcClient({ transport: { kind: "local" }, spawner: fake.spawner });
    fake.once("call", (call: { id: number }) => {
      const hello = `${JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          generation: 1,
          version: "0.1.21",
          core: { id: "core-1", name: "rohan" },
          framed: true,
          methods: [],
          features: ["framed", "automatic_input"],
        },
      })}\n`;
      fake.sendRaw(Buffer.from(hello, "utf8"));
      // The core reads frames from the next byte on.
      fake.becomeFramed();
    });
    await hc.connect();

    const opening = hc.attach({ terminal: "t1", cols: 80, rows: 24 });
    await settle();
    const call = fake.call("terminal.attach")!;
    // One write: the reply on channel 0, then the paint on its own channel.
    const reply = JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        channel: 9,
        terminal: terminal("t1"),
        automatic_input: true,
        resize_notifications: false,
      },
    });
    fake.sendRaw(
      Buffer.concat([
        encodeFrame(0, FrameKind.DATA, Buffer.from(reply, "utf8")),
        encodeFrame(9, FrameKind.DATA, Buffer.from("paint")),
      ]),
    );
    const stream = await opening;
    const seen: string[] = [];
    stream.on("data", (bytes) => seen.push(Buffer.from(bytes).toString()));
    expect(seen).toEqual(["paint"]);
    hc.close();
  });
});
