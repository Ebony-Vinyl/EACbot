import { describe, expect, it } from "vitest";

import { HcConnection } from "./connection.ts";
import { RpcError, TransportError } from "./protocol.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import { localConnectPlan, sshConnectPlan, type SshConnectConfig } from "./transport.ts";

const REMOTE: SshConnectConfig = {
  host: "rohan",
  user: "me",
  knownHostsFile: "/var/lib/eacbot/known_hosts",
};
import { FrameKind, encodeFrame, resizePayload } from "./wire.ts";

async function connected(options: { framed?: boolean; requestTimeoutMs?: number } = {}) {
  const fake = new FakeHc();
  const connection = new HcConnection({
    plan: localConnectPlan(),
    spawner: fake.spawner,
    requestTimeoutMs: options.requestTimeoutMs,
  }).open();
  await connection.handshake({ framed: options.framed ?? false });
  return { fake, connection };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("hello", () => {
  it("sends generation 1 and switches to framed mode after the reply", async () => {
    const fake = new FakeHc();
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    const result = await connection.handshake({ framed: true });
    expect(result.generation).toBe(1);
    expect(result.framed).toBe(true);
    expect(connection.mode).toBe("framed");
    expect(fake.call("hello")?.params).toMatchObject({ generation: 1, framed: true });
    connection.close();
  });

  it("stays in plain mode when the caller does not ask for frames", async () => {
    const { connection } = await connected({ framed: false });
    expect(connection.mode).toBe("plain");
    connection.close();
  });

  it("refuses a core that speaks another generation", async () => {
    const fake = new FakeHc({ generation: 2 });
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    await expect(connection.handshake()).rejects.toMatchObject({ kind: "unsupported_generation" });
    connection.close();
  });

  it("surfaces the core's unsupported_generation error with its kind and hint", async () => {
    const fake = new FakeHc({
      helloError: {
        code: -32000,
        message: "protocol generation 9 not supported",
        kind: "unsupported_generation",
        hint: "this core speaks generation 1",
      },
    });
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    const error = await connection.handshake().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe("unsupported_generation");
    expect((error as RpcError).hint).toBe("this core speaks generation 1");
    connection.close();
  });

  it("advertises a feature only when the core lists it", async () => {
    const fake = new FakeHc({ features: ["framed"] });
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    await connection.handshake({ framed: true });
    expect(connection.supports("framed")).toBe(true);
    expect(connection.supports("automatic_input")).toBe(false);
    connection.close();
  });
});

describe("plain and framed framing", () => {
  it("writes plain calls as one JSON line each", async () => {
    const { fake, connection } = await connected();
    const call = connection.request("terminal.list", { all: false });
    await settle();
    expect(fake.callsOf("terminal.list")).toHaveLength(1);
    fake.answerList(fake.call("terminal.list")!);
    await expect(call).resolves.toMatchObject({ terminals: [] });
    connection.close();
  });

  it("writes framed calls as DATA on channel 0", async () => {
    const { fake, connection } = await connected({ framed: true });
    const call = connection.request("terminal.list", {});
    await settle();
    const frames = fake.framesIn.filter((frame) => frame.channel === 0 && frame.kind === FrameKind.DATA);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(Buffer.from(frames[0]!.payload).toString())).toMatchObject({ method: "terminal.list" });
    fake.answerList(fake.call("terminal.list")!);
    await call;
    connection.close();
  });

  it("splits plain replies that arrive in pieces and batches", async () => {
    const { fake, connection } = await connected();
    const first = connection.request("terminal.list", {});
    const second = connection.request("terminal.list", {});
    await settle();
    const [a, b] = fake.callsOf("terminal.list");
    const lineA = `${JSON.stringify({ jsonrpc: "2.0", id: a!.id, result: { terminals: [], hidden_finished: 0, machines: [] } })}\n`;
    const lineB = `${JSON.stringify({ jsonrpc: "2.0", id: b!.id, result: { terminals: [], hidden_finished: 1, machines: [] } })}\n`;
    const all = lineA + lineB;
    for (const char of all.slice(0, 12)) fake.sendRaw(Buffer.from(char));
    fake.sendRaw(Buffer.from(all.slice(12)));
    await expect(first).resolves.toMatchObject({ hidden_finished: 0 });
    await expect(second).resolves.toMatchObject({ hidden_finished: 1 });
    connection.close();
  });

  it("reads frames the core sends in the same read as the hello reply", async () => {
    const fake = new FakeHc({ silentHello: true });
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    const beats: unknown[] = [];
    connection.onNotification((method, params) => beats.push({ method, params }));
    const heartbeat = encodeFrame(
      0,
      FrameKind.DATA,
      Buffer.from('{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":7}}'),
    );
    // One write, as the core's writer does: the hello line and the first frame.
    fake.once("call", (call: { id: number }) => {
      const reply = `${JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          generation: 1,
          version: "0.1.21",
          core: { id: "core-1", name: "rohan" },
          framed: true,
          methods: [],
          features: ["framed"],
        },
      })}\n`;
      fake.sendRaw(Buffer.concat([Buffer.from(reply, "utf8"), heartbeat]));
    });
    await connection.handshake({ framed: true });
    expect(connection.mode).toBe("framed");
    expect(beats).toEqual([{ method: "heartbeat", params: { seq: 7 } }]);
    connection.close();
  });
});

describe("request multiplexing", () => {
  it("runs calls side by side and answers out of order", async () => {
    const { fake, connection } = await connected({ framed: true });
    const slow = connection.request("terminal.interrupt", { terminal: "t1" });
    const fast = connection.request("terminal.list", {});
    await settle();
    expect(fake.callsOf("terminal.interrupt")).toHaveLength(1);
    expect(fake.callsOf("terminal.list")).toHaveLength(1);

    fake.answerList(fake.call("terminal.list")!);
    await expect(fast).resolves.toMatchObject({ terminals: [] });
    let slowSettled = false;
    void slow.then(
      () => (slowSettled = true),
      () => (slowSettled = true),
    );
    await settle();
    expect(slowSettled).toBe(false);

    fake.reply(fake.call("terminal.interrupt")!, { outcome: "stopped", key: "ctrl+c" });
    await expect(slow).resolves.toEqual({ outcome: "stopped", key: "ctrl+c" });
    connection.close();
  });

  it("keeps 64 concurrent calls apart by id", async () => {
    const { fake, connection } = await connected({ framed: true });
    const calls = Array.from({ length: 64 }, (_, index) =>
      connection.request<{ n: number }>("terminal.list", { n: index }),
    );
    await settle();
    const listed = fake.callsOf("terminal.list");
    expect(listed).toHaveLength(64);
    for (const call of [...listed].reverse()) {
      fake.reply(call, { terminals: [], hidden_finished: 0, machines: [], n: call.params.n });
    }
    const results = await Promise.all(calls);
    expect(results.map((result) => result.n)).toEqual(Array.from({ length: 64 }, (_, index) => index));
    connection.close();
  });

  it("rejects with the core's error kind rather than a generic failure", async () => {
    const { fake, connection } = await connected({ framed: true });
    const call = connection.request("terminal.attach", { terminal: "t9" });
    await settle();
    fake.replyError(fake.call("terminal.attach")!, {
      code: -32000,
      message: "no terminal t9",
      kind: "not_found",
      hint: "hc ls",
    });
    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe("not_found");
    expect((error as RpcError).hint).toBe("hc ls");
    expect((error as RpcError).code).toBe(-32000);
    connection.close();
  });

  it("times a call out instead of hanging forever", async () => {
    const { connection } = await connected({ framed: true, requestTimeoutMs: 20 });
    await expect(connection.request("terminal.list", {})).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });
});

describe("connection loss", () => {
  it("rejects everything in flight when the core dies", async () => {
    const { fake, connection } = await connected({ framed: true });
    const first = connection.request("terminal.list", {});
    const second = connection.request("terminal.interrupt", { terminal: "t1" });
    await settle();
    fake.crash("the core died");
    await expect(first).rejects.toBeInstanceOf(TransportError);
    await expect(second).rejects.toBeInstanceOf(TransportError);
    expect(connection.closed).toBe(true);
  });

  it("tells channel sinks the connection ended", async () => {
    const { fake, connection } = await connected({ framed: true });
    const seen: unknown[] = [];
    connection.registerChannel(5, { onFrame: () => {}, onChannelClosed: (error) => seen.push(error) });
    fake.crash();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(TransportError);
  });

  it("carries the child's stderr into the loss message", async () => {
    const { fake, connection } = await connected({ framed: true });
    const call = connection.request("terminal.list", {});
    await settle();
    fake.crash("ssh: connect to host rohan port 22: Connection refused");
    const error = await call.catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("Connection refused");
  });

  it("refuses to send after it ended", async () => {
    const { fake, connection } = await connected({ framed: true });
    fake.crash();
    await expect(connection.request("terminal.list", {})).rejects.toBeInstanceOf(TransportError);
    await expect(connection.sendFrame(1, FrameKind.DATA, Buffer.from("x"))).rejects.toBeInstanceOf(TransportError);
  });

  it("calls the close handler once, not once per signal", async () => {
    const { fake, connection } = await connected({ framed: true });
    let closes = 0;
    connection.onClose(() => (closes += 1));
    fake.crash();
    connection.close();
    expect(closes).toBe(1);
  });
});

describe("channel routing", () => {
  it("gives each channel only its own frames", async () => {
    const { fake, connection } = await connected({ framed: true });
    const one: number[] = [];
    const two: number[] = [];
    connection.registerChannel(1, { onFrame: (frame) => one.push(frame.payload.byteLength) });
    connection.registerChannel(2, { onFrame: (frame) => two.push(frame.payload.byteLength) });
    fake.sendFrame(1, FrameKind.DATA, Buffer.alloc(3));
    fake.sendFrame(2, FrameKind.DATA, Buffer.alloc(7));
    fake.sendFrame(3, FrameKind.DATA, Buffer.alloc(11));
    expect(one).toEqual([3]);
    expect(two).toEqual([7]);
    connection.close();
  });

  it("refuses to register one channel twice", async () => {
    const { connection } = await connected({ framed: true });
    connection.registerChannel(1, { onFrame: () => {} });
    expect(() => connection.registerChannel(1, { onFrame: () => {} })).toThrow(TransportError);
    connection.close();
  });

  it("holds a stream's first frames until its channel is registered", async () => {
    const { fake, connection } = await connected({ framed: true });
    // The reply and the first paint land in one read, before the sink exists.
    fake.sendFrame(4, FrameKind.DATA, Buffer.from("first paint"));
    fake.sendFrame(4, FrameKind.RESIZE, resizePayload(80, 24));
    const seen: string[] = [];
    connection.registerChannel(4, {
      onFrame: (frame) =>
        seen.push(frame.kind === FrameKind.DATA ? Buffer.from(frame.payload).toString() : "resize"),
    });
    expect(seen).toEqual(["first paint", "resize"]);
    connection.close();
  });

  it("keeps one sink's throw from taking the connection down", async () => {
    const { fake, connection } = await connected({ framed: true });
    connection.registerChannel(1, {
      onFrame: () => {
        throw new Error("consumer bug");
      },
    });
    fake.sendFrame(1, FrameKind.DATA, Buffer.from("x"));
    fake.sendFrame(1, FrameKind.DATA, Buffer.from("y"));
    expect(connection.closed).toBe(false);
    connection.close();
  });
});

describe("transport plans", () => {
  it("runs hc connect locally with no shell in between", () => {
    const plan = localConnectPlan();
    expect(plan.command).toBe("herdr-core");
    expect(plan.args).toEqual(["connect"]);
    expect(plan.env).toBeUndefined();
  });

  it("selects a session through the environment, as the CLI does", () => {
    expect(localConnectPlan({ session: "work" }).env).toEqual({ HC_SESSION: "work" });
  });

  it("runs hc connect on the far side over ssh, as one argv", () => {
    const plan = sshConnectPlan(REMOTE);
    expect(plan.command).toBe("ssh");
    expect(plan.args[0]).toBe("-T");
    expect(plan.args.at(-2)).toBe("rohan");
    expect(plan.args.at(-1)).toContain("connect");
  });

  it("never lets a host become an ssh option or two words", () => {
    const bad = ["-oProxyCommand=evil", "rohan && rm -rf /", `rohan${"\n"}other`, "", "rohan:22", "me@rohan", "rohan/x"];
    for (const host of bad) {
      expect(() => sshConnectPlan({ ...REMOTE, host }), host).toThrow(TransportError);
    }
  });

  it("finds hc on PATH or in ~/.local/bin on the far side", () => {
    const line = sshConnectPlan(REMOTE).args.at(-1)!;
    expect(line).toContain("command -v herdr-core");
    expect(line).toContain("$HOME/.local/bin/herdr-core");
    expect(line).toContain('exec "$p" connect');
    expect(line).toContain("exit 127");
  });

  it("passes a session to the remote core through its environment", () => {
    expect(sshConnectPlan({ ...REMOTE, session: "work" }).args.at(-1)).toContain("HC_SESSION=work exec");
  });
});

describe("frame writing", () => {
  it("sends CREDIT, RESIZE and DATA on a channel", async () => {
    const { fake, connection } = await connected({ framed: true });
    await connection.sendFrame(6, FrameKind.CREDIT, Buffer.from([0, 0, 4, 0]));
    await connection.sendFrame(6, FrameKind.RESIZE, resizePayload(120, 40));
    await connection.sendFrame(6, FrameKind.DATA, Buffer.from("keys"));
    const sent = fake.framesIn.filter((frame) => frame.channel === 6);
    expect(sent.map((frame) => frame.kind)).toEqual([FrameKind.CREDIT, FrameKind.RESIZE, FrameKind.DATA]);
    connection.close();
  });

  it("writes frames byte for byte as the codec encodes them", async () => {
    const { fake, connection } = await connected({ framed: true });
    const payload = Buffer.from("abc");
    await connection.sendFrame(2, FrameKind.DATA, payload);
    const sent = fake.framesIn.find((frame) => frame.channel === 2)!;
    expect(Buffer.from(sent.payload)).toEqual(payload);
    expect(encodeFrame(2, FrameKind.DATA, payload).byteLength).toBe(12);
    connection.close();
  });
});
