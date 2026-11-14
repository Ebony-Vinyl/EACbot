import { describe, expect, it } from "vitest";

import { AttachStream } from "./attach.ts";
import { HcConnection } from "./connection.ts";
import { ControlLease } from "./lease.ts";
import { RpcError, TransportError } from "./protocol.ts";
import { FakeHc } from "./testing/fake-hc.ts";
import { localConnectPlan } from "./transport.ts";
import { FrameKind, INITIAL_STREAM_CREDIT, MAX_STREAM_CHUNK, readCredit, readResize } from "./wire.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function attached(
  options: {
    observe?: boolean;
    history?: number;
    fake?: FakeHc;
    attach?: Parameters<FakeHc["answerAttach"]>[1];
    creditBatch?: number;
    lease?: ControlLease;
  } = {},
) {
  const fake = options.fake ?? new FakeHc();
  const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
  await connection.handshake({ framed: true });
  const stream = new AttachStream(
    connection,
    {
      terminal: "t1",
      cols: 80,
      rows: 24,
      observe: options.observe,
      history: options.history,
      creditBatch: options.creditBatch,
    },
    options.lease,
  );
  const opening = stream.open();
  await settle();
  const call = fake.call("terminal.attach")!;
  const channel = fake.answerAttach(call, options.attach);
  await opening;
  return { fake, connection, stream, channel, call };
}

describe("attach", () => {
  it("sends the viewer's size, history and observe flag", async () => {
    const { call, connection } = await attached({ history: 500, observe: true });
    expect(call.params).toMatchObject({ terminal: "t1", cols: 80, rows: 24, history: 500, observe: true });
    connection.close();
  });

  it("asks for resize notifications only when the observer wants them", async () => {
    const fake = new FakeHc();
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    await connection.handshake({ framed: true });
    const stream = new AttachStream(connection, { terminal: "t1", cols: 80, rows: 24, observe: true, resizeNotifications: true });
    const opening = stream.open();
    await settle();
    expect(fake.call("terminal.attach")?.params).toMatchObject({ resize_notifications: true });
    fake.answerAttach(fake.call("terminal.attach")!, { resize_notifications: true });
    await opening;
    connection.close();
  });

  it("needs a framed connection and says so with needs_framed", async () => {
    const fake = new FakeHc();
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    await connection.handshake({ framed: false });
    const stream = new AttachStream(connection, { terminal: "t1", cols: 80, rows: 24 });
    const error = await stream.open().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe("needs_framed");
    connection.close();
  });

  it("delivers the first paint before any live output", async () => {
    const { fake, stream, channel, connection } = await attached();
    const seen: string[] = [];
    stream.on("data", (bytes) => seen.push(Buffer.from(bytes).toString()));
    fake.streamData(channel, Buffer.from("PAINT\r\n$ "));
    fake.streamData(channel, Buffer.from("live\r\n"));
    expect(seen.join("")).toBe("PAINT\r\n$ live\r\n");
    expect(stream.paintReceived).toBe(true);
    connection.close();
  });

  it("keeps a stream's bytes whole across chunk boundaries", async () => {
    const { fake, stream, channel, connection } = await attached();
    const chunks: Buffer[] = [];
    stream.on("data", (bytes) => chunks.push(Buffer.from(bytes)));
    const text = Buffer.from("a".repeat(1000));
    for (let at = 0; at < text.byteLength; at += 7) fake.streamData(channel, text.subarray(at, at + 7));
    expect(Buffer.concat(chunks).toString()).toBe(text.toString());
    connection.close();
  });

  it("emits RESIZE from the core for an observing viewer", async () => {
    const { fake, stream, channel, connection } = await attached({ observe: true });
    const sizes: unknown[] = [];
    stream.on("resize", (size) => sizes.push(size));
    fake.sendFrame(channel, FrameKind.RESIZE, Buffer.from([120, 0, 40, 0]));
    expect(sizes).toEqual([{ cols: 120, rows: 40 }]);
    connection.close();
  });
});

describe("credit", () => {
  it("sends CREDIT for the bytes it consumed, in batches", async () => {
    const { fake, stream, channel, connection } = await attached();
    stream.on("data", () => {});
    fake.streamData(channel, Buffer.alloc(MAX_STREAM_CHUNK));
    await settle();
    expect(fake.credited(channel)).toBe(0);
    for (let sent = MAX_STREAM_CHUNK; sent < INITIAL_STREAM_CREDIT; sent += MAX_STREAM_CHUNK) {
      fake.streamData(channel, Buffer.alloc(MAX_STREAM_CHUNK));
    }
    await settle();
    const credits = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.CREDIT);
    expect(credits).toHaveLength(1);
    expect(readCredit(credits[0]!.payload)).toBe(INITIAL_STREAM_CREDIT);
    connection.close();
  });

  it("returns credit in the batch size the caller asked for", async () => {
    const { fake, stream, channel, connection } = await attached({ creditBatch: 1024 });
    stream.on("data", () => {});
    fake.streamData(channel, Buffer.alloc(1024));
    await settle();
    const credits = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.CREDIT);
    expect(credits.map((frame) => readCredit(frame.payload))).toEqual([1024]);
    connection.close();
  });

  it("stops the core from sending past the window until it acknowledges", async () => {
    const { fake, stream, channel, connection } = await attached();
    const received: number[] = [];
    stream.on("data", (bytes) => received.push(bytes.byteLength));
    // The core will not push more than 256 KiB before the viewer acknowledges.
    fake.streamData(channel, Buffer.alloc(INITIAL_STREAM_CREDIT + 4096));
    const delivered = received.reduce((sum, bytes) => sum + bytes, 0);
    expect(delivered).toBeLessThanOrEqual(INITIAL_STREAM_CREDIT);
    connection.close();
  });
});

describe("viewer input", () => {
  it("sends keys as DATA on the stream channel", async () => {
    const { fake, stream, channel, connection } = await attached();
    await stream.sendInput(Buffer.from("ls\r"));
    const data = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.DATA);
    expect(Buffer.from(data.at(-1)!.payload).toString()).toBe("ls\r");
    connection.close();
  });

  it("refuses input from an observer", async () => {
    const { stream, connection } = await attached({ observe: true });
    await expect(stream.sendInput(Buffer.from("rm -rf /"))).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });

  it("refuses input once control was revoked", async () => {
    const lease = new ControlLease();
    const { stream, connection } = await attached({ lease });
    await stream.sendInput(Buffer.from("a"));
    lease.revoke("a person took over");
    await expect(stream.sendInput(Buffer.from("b"))).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });

  it("refuses to write before the stream opened", async () => {
    const fake = new FakeHc();
    const connection = new HcConnection({ plan: localConnectPlan(), spawner: fake.spawner }).open();
    await connection.handshake({ framed: true });
    const stream = new AttachStream(connection, { terminal: "t1", cols: 80, rows: 24 });
    await expect(stream.sendInput(Buffer.from("x"))).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });

  it("refuses resize from an observer", async () => {
    const { stream, connection } = await attached({ observe: true });
    await expect(stream.resize(120, 40)).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });

  it("sends RESIZE only while this viewer holds control", async () => {
    const lease = new ControlLease();
    const { fake, stream, channel, connection } = await attached({ lease });
    await stream.resize(120, 40);
    const resizes = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.RESIZE);
    expect(resizes.map((frame) => readResize(frame.payload))).toEqual([{ cols: 120, rows: 40 }]);
    lease.revoke("another viewer typed");
    await expect(stream.resize(100, 30)).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });

  it("reports FOCUS and display FACTS as frames", async () => {
    const { fake, stream, channel, connection } = await attached();
    await stream.focus(true);
    await stream.reportDisplayFacts({ bg: "#101010", fg: "#f0f0f0", cell: [9, 18] });
    const frames = fake.framesIn.filter((frame) => frame.channel === channel);
    expect(frames.map((frame) => frame.kind)).toEqual([FrameKind.FOCUS, FrameKind.FACTS]);
    expect([...frames[0]!.payload]).toEqual([1]);
    expect(JSON.parse(Buffer.from(frames[1]!.payload).toString())).toEqual({
      bg: "#101010",
      fg: "#f0f0f0",
      cell: [9, 18],
    });
    connection.close();
  });
});

describe("automatic input", () => {
  it("uses kind 6 when both hello and attach confirm support", async () => {
    const { fake, stream, channel, connection } = await attached({ attach: { automatic_input: true } });
    expect(stream.automaticInputSupported).toBe(true);
    await stream.sendAutomaticInput(Buffer.from("\x1b]11;rgb:0000/0000/0000\x1b\\"));
    const automatic = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.AUTOMATIC_INPUT);
    expect(automatic).toHaveLength(1);
    connection.close();
  });

  it("falls back to DATA when attach does not confirm it", async () => {
    const { fake, stream, channel, connection } = await attached({ attach: { automatic_input: false } });
    expect(stream.automaticInputSupported).toBe(false);
    await stream.sendAutomaticInput(Buffer.from("\x1b[?62;22c"));
    const automatic = fake.framesIn.filter((frame) => frame.kind === FrameKind.AUTOMATIC_INPUT);
    const data = fake.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.DATA);
    expect(automatic).toHaveLength(0);
    expect(Buffer.from(data.at(-1)!.payload).toString()).toBe("\x1b[?62;22c");
    connection.close();
  });

  it("falls back to DATA when hello does not advertise the feature", async () => {
    const fake = new FakeHc({ features: ["framed", "attach"] });
    const { stream, fake: used, channel } = await attached({ fake, attach: { automatic_input: true } });
    expect(stream.automaticInputSupported).toBe(false);
    await stream.sendAutomaticInput(Buffer.from("\x1b[?62;22c"));
    const automatic = used.framesIn.filter((frame) => frame.kind === FrameKind.AUTOMATIC_INPUT);
    expect(automatic).toHaveLength(0);
    const data = used.framesIn.filter((frame) => frame.channel === channel && frame.kind === FrameKind.DATA);
    expect(Buffer.from(data.at(-1)!.payload).toString()).toBe("\x1b[?62;22c");
  });

  it("never sends automatic input from an observer", async () => {
    const { stream, connection } = await attached({ observe: true });
    await expect(stream.sendAutomaticInput(Buffer.from("\x1b[?62;22c"))).rejects.toBeInstanceOf(TransportError);
    connection.close();
  });
});

describe("stream end", () => {
  it("detaches with CLOSE and reports the viewer detached", async () => {
    const { fake, stream, channel, connection } = await attached();
    const closed: unknown[] = [];
    stream.on("close", (event) => closed.push(event));
    await stream.detach();
    const sent = fake.framesIn.find((frame) => frame.channel === channel && frame.kind === FrameKind.CLOSE);
    expect(sent).toBeDefined();
    expect(closed).toEqual([{ reason: null, detached: true }]);
    expect(stream.closed).toBe(true);
    connection.close();
  });

  it("reports the core's reason when the program exits", async () => {
    const { fake, stream, channel, connection } = await attached();
    const closed: unknown[] = [];
    stream.on("close", (event) => closed.push(event));
    fake.sendFrame(channel, FrameKind.CLOSE, Buffer.from(JSON.stringify({ reason: "exited", exit_code: 0, signal: null })));
    expect(closed).toEqual([{ reason: { reason: "exited", exit_code: 0, signal: null }, detached: false }]);
    connection.close();
  });

  it("reports a lost connection rather than a clean close", async () => {
    const { fake, stream, connection } = await attached();
    const lost: unknown[] = [];
    stream.on("lost", (error) => lost.push(error));
    fake.crash();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(TransportError);
    expect(stream.closed).toBe(true);
    connection.close();
  });

  it("ignores frames after it ended", async () => {
    const { fake, stream, channel, connection } = await attached();
    const seen: unknown[] = [];
    stream.on("data", (bytes) => seen.push(bytes));
    await stream.detach();
    fake.sendFrame(channel, FrameKind.DATA, Buffer.from("late"));
    expect(seen).toHaveLength(0);
    connection.close();
  });

  it("hands a listener the close that arrived before it subscribed", async () => {
    const { fake, stream, channel, connection } = await attached();
    // The program exits in the same read as the first paint.
    fake.sendFrame(channel, FrameKind.DATA, Buffer.from("last screen"));
    fake.sendFrame(channel, FrameKind.CLOSE, Buffer.from(JSON.stringify({ reason: "exited", exit_code: 0 })));
    expect(stream.closed).toBe(true);
    const seen: unknown[] = [];
    stream.on("close", (event) => seen.push(event));
    expect(seen).toEqual([{ reason: { reason: "exited", exit_code: 0 }, detached: false }]);
    connection.close();
  });

  it("hands a late data listener the paint it missed", async () => {
    const { fake, stream, channel, connection } = await attached();
    fake.streamData(channel, Buffer.from("paint"));
    const seen: string[] = [];
    stream.on("data", (bytes) => seen.push(Buffer.from(bytes).toString()));
    expect(seen).toEqual(["paint"]);
    // Only once: the buffer is drained.
    stream.on("data", (bytes) => seen.push(Buffer.from(bytes).toString()));
    expect(seen).toEqual(["paint"]);
    connection.close();
  });
});

describe("control lease", () => {
  it("gives control to one viewer and observing to another", () => {
    const lease = new ControlLease();
    lease.attach("browser", "control");
    lease.attach("phone", "observe");
    expect(lease.canControl("browser")).toBe(true);
    expect(lease.canControl("phone")).toBe(false);
    expect(() => lease.assertCanResize("phone")).toThrow(TransportError);
    expect(() => lease.assertCanInput("phone")).toThrow(TransportError);
  });

  it("takes control away from the previous holder and reports it", () => {
    const revoked: unknown[] = [];
    const lease = new ControlLease({ onRevoked: (holder, reason) => revoked.push({ id: holder.id, reason }) });
    lease.attach("agent", "control");
    lease.attach("person", "control");
    expect(lease.canControl("agent")).toBe(false);
    expect(lease.canControl("person")).toBe(true);
    expect(revoked).toEqual([{ id: "agent", reason: "control taken by person" }]);
  });

  it("revokes control without dropping the holder's stream", () => {
    const lease = new ControlLease();
    lease.attach("agent", "control");
    const revoked = lease.revoke("a person typed");
    expect(revoked?.id).toBe("agent");
    expect(lease.controller).toBeNull();
    expect(lease.holders.map((holder) => holder.id)).toEqual(["agent"]);
    expect(lease.revokedReason).toBe("a person typed");
  });

  it("hands control back to a viewer that is still attached", () => {
    const lease = new ControlLease();
    lease.attach("agent", "control");
    lease.attach("phone", "observe");
    lease.take("phone");
    expect(lease.canControl("phone")).toBe(true);
    expect(lease.canControl("agent")).toBe(false);
  });

  it("refuses control for a viewer that is not attached", () => {
    const lease = new ControlLease();
    expect(() => lease.take("nobody")).toThrow(TransportError);
  });

  it("clears control when the controller detaches", () => {
    const lease = new ControlLease();
    lease.attach("agent", "control");
    lease.detach("agent");
    expect(lease.controller).toBeNull();
    expect(lease.holders).toHaveLength(0);
  });
});
