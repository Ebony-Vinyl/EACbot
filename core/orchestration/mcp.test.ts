import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { MCP_ERROR, MCP_PROTOCOL_VERSION, McpServer, MemoryTransport, lineTransport, type McpMessage } from "./mcp.ts";
import { createToolFixture, toolMission, type Fixture } from "./fixture.ts";

/** A reply the server must have produced; a missing one is a test failure with
 * a readable message rather than a TypeError. */
function replyOf(reply: McpMessage | null): McpMessage {
  if (reply === null) throw new Error("the server sent no reply");
  return reply;
}

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture(): Fixture {
  const created = createToolFixture();
  open.push(created);
  return created;
}

function serverOf(f: Fixture): McpServer {
  return new McpServer({ tools: f.tools });
}

function request(id: number, method: string, params?: unknown): McpMessage {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

describe("MCP handshake", () => {
  it("answers initialize with the protocol version and a tools capability", async () => {
    const f = fixture();
    const reply = await serverOf(f).handle(request(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION }));
    expect(reply?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
    });
    expect((replyOf(reply).result as { serverInfo: { name: string } }).serverInfo.name).toBe("eacbot-orchestration");
  });

  it("refuses tools/list before initialize", async () => {
    const f = fixture();
    const reply = await serverOf(f).handle(request(1, "tools/list"));
    expect(reply?.error?.code).toBe(MCP_ERROR.INVALID_REQUEST);
  });

  it("lists the twelve orchestration tools after initialize", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(request(2, "tools/list"));
    const tools = (replyOf(reply).result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_agents",
      "list_missions",
      "create_mission",
      "steer_run",
      "interrupt_run",
      "resume_mission",
      "cancel_mission",
      "mission_status",
      "list_approvals",
      "answer_approval",
      "open_terminal",
      "get_artifact",
    ]);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  });

  it("answers ping and takes notifications without a reply", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    expect((await server.handle(request(2, "ping")))?.result).toEqual({});
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("refuses an unknown method and a non-2.0 envelope", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const unknown = await server.handle(request(2, "resources/list"));
    expect(unknown?.error?.code).toBe(MCP_ERROR.METHOD_NOT_FOUND);
    const bad = await server.handle({ jsonrpc: "1.0" as never, id: 3, method: "ping" });
    expect(bad?.error?.code).toBe(MCP_ERROR.INVALID_REQUEST);
  });
});

describe("MCP tools/call", () => {
  it("runs a tool and returns a structured result", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(
      request(2, "tools/call", {
        name: "list_missions",
        arguments: {},
        _meta: { token: f.token() },
      }),
    );
    const result = reply?.result as {
      content: { type: string; text: string }[];
      structuredContent: { ok: boolean; tool: string };
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.tool).toBe("list_missions");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, tool: "list_missions" });
  });

  it("refuses a call with no token as a tool error, not a transport error", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(request(2, "tools/call", { name: "list_missions", arguments: {} }));
    const result = reply?.result as { isError: boolean; structuredContent: { error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("unauthenticated");
  });

  it("refuses an expired token presented at the transport", async () => {
    const f = fixture();
    const token = f.token({ expiresAt: new Date(Date.parse(f.wall.now()) + 1_000).toISOString() });
    f.wall.advance(60_000);
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(request(2, "tools/call", { name: "list_missions", arguments: {}, _meta: { token } }));
    const result = reply?.result as { isError: boolean; structuredContent: { error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("unauthenticated");
  });

  it("refuses a forged token presented at the transport", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(
      request(2, "tools/call", { name: "list_missions", arguments: {}, _meta: { token: "v1.eyJ2IjoxfQ.deadbeef" } }),
    );
    const result = reply?.result as { isError: boolean; structuredContent: { error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("unauthenticated");
  });

  it("refuses arguments that are not an object", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(
      request(2, "tools/call", { name: "list_missions", arguments: [1, 2], _meta: { token: f.token() } }),
    );
    expect(reply?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it("refuses a call with no tool name", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(request(2, "tools/call", { arguments: {}, _meta: { token: f.token() } }));
    expect(reply?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it("carries a real mission through create then status", async () => {
    const f = fixture();
    const server = serverOf(f);
    const token = f.token();
    await server.handle(request(1, "initialize", {}));

    const created = await server.handle(
      request(2, "tools/call", {
        name: "create_mission",
        arguments: {
          commandId: "mcp-create",
          agent: "hermes",
          environment: { id: "env", label: "pc", kind: "local", authMode: "local" },
          brief: { objective: "check the log", doneWhen: ["checked"], permissionLevel: "read-only", source: { kind: "hermes" } },
        },
        _meta: { token },
      }),
    );
    const createdData = (replyOf(created).result as { structuredContent: { data: { missionId: string } } }).structuredContent;
    expect(createdData.data.missionId).toBeTruthy();

    const status = await server.handle(
      request(3, "tools/call", {
        name: "mission_status",
        arguments: { missionId: createdData.data.missionId },
        _meta: { token },
      }),
    );
    const statusData = (replyOf(status).result as { structuredContent: { data: { mission: { id: string } } } }).structuredContent;
    expect(statusData.data.mission.id).toBe(createdData.data.missionId);
  });
});

describe("stdio framing", () => {
  it("reads one JSON message per line and writes one per reply", async () => {
    const f = fixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));

    const transport = lineTransport(input, output);
    const server = serverOf(f);
    const serving = server.serve(transport);

    input.write(`${JSON.stringify(request(1, "initialize", {}))}\n`);
    input.write(`${JSON.stringify(request(2, "tools/list"))}\n`);
    input.end();

    await serving;
    const lines = written.join("").trim().split("\n").map((line) => JSON.parse(line) as McpMessage);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.id).toBe(1);
    expect((lines[1]!.result as { tools: unknown[] }).tools.length).toBe(12);
    expect(transport).toBeDefined();
  });

  it("answers a malformed line with a parse error and keeps reading", async () => {
    const f = fixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));

    const serving = serverOf(f).serve(lineTransport(input, output));
    input.write("not json\n");
    input.write(`${JSON.stringify(request(2, "initialize", {}))}\n`);
    input.end();
    await serving;

    const lines = written.join("").trim().split("\n").map((line) => JSON.parse(line) as McpMessage);
    expect(lines[0]!.error?.code).toBe(MCP_ERROR.PARSE_ERROR);
    expect(lines[1]!.id).toBe(2);
  });

  it("serves an in-memory transport to completion", async () => {
    const f = fixture();
    const transport = new MemoryTransport();
    transport.push(request(1, "initialize", {}));
    transport.push(request(2, "tools/list"));
    const serving = serverOf(f).serve(transport);
    await serving;
    expect(transport.written).toHaveLength(2);
    expect(transport.closed).toBe(true);
  });
});

describe("MCP does not invent authority", () => {
  it("ignores a token smuggled inside arguments", async () => {
    const f = fixture();
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(
      request(2, "tools/call", {
        name: "list_missions",
        arguments: { token: f.token() },
        _meta: { token: f.token() },
      }),
    );
    const result = reply?.result as { isError: boolean; structuredContent: { error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("scope_from_arguments_refused");
  });

  it("uses the transport token's scope, not the caller's claim about it", async () => {
    const f = fixture();
    const mine = await toolMission(f, { commandId: "c1" });
    const theirs = await toolMission(f, { commandId: "c2" });
    const server = serverOf(f);
    await server.handle(request(1, "initialize", {}));
    const reply = await server.handle(
      request(2, "tools/call", {
        name: "mission_status",
        arguments: { missionId: theirs.missionId },
        _meta: { token: f.token({ rootMissionIds: [mine.missionId] }) },
      }),
    );
    const result = reply?.result as { isError: boolean; structuredContent: { error: { code: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("scope_denied");
  });
});
