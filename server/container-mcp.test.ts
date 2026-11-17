import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CONTAINER, CUA_EXECUTABLE, CUA_SOCKET } from "./container-computer.ts";
import { CONTROL_PLANE_MISSING } from "./control-client.ts";
import { omittedFromErrorNote } from "./mcp-error-result.ts";

const temporary: string[] = [];

/** A loopback gate that frees the computer, so a call reaches the driver. */
async function freeControlGate() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ held: false, helpOpen: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    env: {
      EAC_CONTROL_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/internal/computer-control?botId=b`,
      EAC_CONTROL_TOKEN: "fixture-token",
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The fake Docker executable below is a POSIX shell script. The production
// bridge remains portable; only this byte-for-byte process fixture is gated.
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Local VM Cua MCP bridge", () => {
  it("passes MCP bytes unchanged to cua-driver mcp over the container runtime", async () => {
    const bin = await mkdtemp(join(tmpdir(), "eacbot-container-mcp-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(
      fakeDocker,
      "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\" >&2\ncat\n",
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: { ...process.env, EAC_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toContain(
      `ARGS:exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
        `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ` +
        `${CUA_EXECUTABLE} mcp --socket ${CUA_SOCKET}`,
    );
  });

  it("answers ping locally so the bundled cua-driver is not invoked", async () => {
    const bin = await mkdtemp(join(tmpdir(), "eacbot-container-mcp-ping-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(
      fakeDocker,
      `#!/bin/sh\n` +
        `printf 'ARGS:%s\\n' "$*" >&2\n` +
        `while IFS= read -r line; do\n` +
        `  case "$line" in\n` +
        `    *'"method":"ping"'* ) printf 'PING-RECEIVED:%s\\n' "$line" >&2 ;;\n` +
        `    *'"method":"tools/list"'* ) printf '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\\n' ;;\n` +
        `  esac\n` +
        `done\n`,
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input =
      '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}\n' +
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: { ...process.env, EAC_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    ]);
    expect(result.stderr).not.toContain("PING-RECEIVED");
    expect(result.stderr).toContain(
      `ARGS:exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
        `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ` +
        `${CUA_EXECUTABLE} mcp --socket ${CUA_SOCKET}`,
    );
  });
  it("never hands an engine an error result that carries a screenshot", async () => {
    const bin = await mkdtemp(join(tmpdir(), "eacbot-container-mcp-error-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    // cua-driver 0.37.0 answers a refused action with its error text plus a screenshot; success keeps its screenshot.
    await writeFile(
      fakeDocker,
      `#!/bin/sh\n` +
        `while IFS= read -r line; do\n` +
        `  case "$line" in\n` +
        `    *'"id":1'* ) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"refused"},{"type":"image","data":"iVBORw0KGgo=","mimeType":"image/png"}],"isError":true}}' ;;\n` +
        `    *'"id":2'* ) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"image","data":"iVBORw0KGgo=","mimeType":"image/png"}]}}' ;;\n` +
        `  esac\n` +
        `done\n`,
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);
    const gate = await freeControlGate();

    const input =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"click","arguments":{}}}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_desktop_state","arguments":{}}}\n';
    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
          {
            env: { ...process.env, ...gate.env, EAC_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    } finally {
      await gate.close();
    }

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "refused" }, { type: "text", text: omittedFromErrorNote(1) }], isError: true },
      },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } },
    ]);
  });

  it("refuses a computer call whose control gate is missing, and says why", async () => {
    const bin = await mkdtemp(join(tmpdir(), "eacbot-container-mcp-gateless-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(
      fakeDocker,
      `#!/bin/sh\n` +
        `while IFS= read -r line; do\n` +
        `  case "$line" in\n` +
        `    *'"method":"tools/list"'* ) printf '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\\n' ;;\n` +
        `    *'"method":"tools/call"'* ) printf 'CALL-RECEIVED:\\n' >&2 ;;\n` +
        `  esac\n` +
        `done\n`,
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input =
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"click","arguments":{}}}\n';
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: { ...process.env, EAC_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1", EAC_CONTROL_URL: "", EAC_CONTROL_TOKEN: "" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // The refusal is written by the bridge and can overtake the child's echo of an earlier request; JSON-RPC matches by id.
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.id === 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(lines.find((line) => line.id === 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: CONTROL_PLANE_MISSING }], isError: true },
    });
    expect(result.stderr).toContain("no control gate configured");
    expect(result.stderr).not.toContain("CALL-RECEIVED");
  });
});
