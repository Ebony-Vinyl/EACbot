import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { STATIC_CONTENT_SECURITY_POLICY, createStaticHandler, type StaticHandlerOptions } from "./static.ts";

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

interface Fixture {
  readonly base: string;
  readonly root: string;
  get(path: string, options?: { method?: string; headers?: Record<string, string> }): Promise<Reply>;
  /** Sends a path exactly as given, including bytes Node's client rejects. */
  raw(path: string, method?: string): Promise<Reply>;
  close(): Promise<void>;
}

const open: Fixture[] = [];
const created: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eac-static-"));
  created.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><title>workbench</title>");
  writeFileSync(join(root, "app-icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  writeFileSync(join(root, "manifest.webmanifest"), "{}");
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "index-BcepHmlG.js"), "console.log(1);");
  writeFileSync(join(root, "assets", "styles--XPDCexI.css"), "body{}");
  writeFileSync(join(root, "assets", "unhashed.js"), "console.log(2);");
  writeFileSync(join(root, "assets", "font-BQhdFMY1.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(root, "assets", "index-BcepHmlG.js.map"), "{}");
  writeFileSync(join(root, "assets", "photo-Dq_IR9rO.webp"), Buffer.from([1, 2, 3]));
  writeFileSync(join(root, "assets", "icon-CTYiF6lA.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(root, "notes.txt"), "hello");
  writeFileSync(join(root, "data.json"), "{}");
  return root;
}

async function start(root: string, options: Partial<StaticHandlerOptions> = {}): Promise<Fixture> {
  const handler = createStaticHandler({ root, ...options });
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (handled || res.headersSent) return;
      res.writeHead(418, { "content-type": "text/plain" });
      res.end("router");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const fixture: Fixture = {
    base: `http://127.0.0.1:${address.port}`,
    root,
    get: (path, requestOptions) => send(address.port, path, requestOptions),
    raw: (path, method) => rawGet(address.port, path, method),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(fixture);
  return fixture;
}

/** Node's HTTP client refuses an unescaped or control-character path before it
 * reaches the wire, so a hostile request is written to a socket by hand. */
function rawGet(port: number, path: string, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffer = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(parseRaw(buffer)));
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
}

function parseRaw(response: string): Reply {
  const boundary = response.indexOf("\r\n\r\n");
  const head = boundary === -1 ? response : response.slice(0, boundary);
  const body = boundary === -1 ? "" : response.slice(boundary + 4);
  const [statusLine, ...lines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number((statusLine ?? "").split(" ")[1] ?? 0), headers, body: Buffer.from(body, "latin1") };
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : (value ?? "")])),
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function canSymlink(kind: "file" | "dir"): boolean {
  const dir = mkdtempSync(join(tmpdir(), "eac-static-link-"));
  try {
    mkdirSync(join(dir, "target"));
    if (kind === "dir") symlinkSync(join(dir, "target"), join(dir, "link"), "junction");
    else {
      writeFileSync(join(dir, "target", "file.txt"), "x");
      symlinkSync(join(dir, "target", "file.txt"), join(dir, "link.txt"));
    }
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fileSymlinks = canSymlink("file");
const dirSymlinks = canSymlink("dir");

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("serving build output", () => {
  it("serves index.html for the root with no-cache and the workbench policy", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-cache");
    expect(reply.headers["content-security-policy"]).toBe(STATIC_CONTENT_SECURITY_POLICY);
    expect(reply.body.toString()).toContain("workbench");
  });

  it("serves a content-hashed asset as immutable with its real type", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/assets/index-BcepHmlG.js");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(reply.body.toString()).toBe("console.log(1);");
  });

  it("leaves an unhashed file in assets revalidating rather than immutable", async () => {
    const f = await start(makeRoot());
    expect((await f.get("/assets/unhashed.js")).headers["cache-control"]).toBe("no-cache");
  });

  it("maps every whitelisted extension to its type", async () => {
    const f = await start(makeRoot());
    const cases: [string, string][] = [
      ["/assets/styles--XPDCexI.css", "text/css; charset=utf-8"],
      ["/assets/font-BQhdFMY1.woff2", "font/woff2"],
      ["/assets/index-BcepHmlG.js.map", "application/json; charset=utf-8"],
      ["/assets/photo-Dq_IR9rO.webp", "image/webp"],
      ["/assets/icon-CTYiF6lA.png", "image/png"],
      ["/app-icon.svg", "image/svg+xml"],
      ["/data.json", "application/json; charset=utf-8"],
      ["/notes.txt", "text/plain; charset=utf-8"],
    ];
    for (const [path, type] of cases) {
      const reply = await f.get(path);
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"], path).toBe(type);
    }
  });

  it("sends an unknown extension as octet-stream instead of letting a browser run it", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/blob.bin");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("streams a file larger than one read, byte for byte", async () => {
    const root = makeRoot();
    const payload = Buffer.alloc(1024 * 1024, 0x61);
    writeFileSync(join(root, "assets", "big-Cw3HIBcK.js"), payload);
    const f = await start(root);
    const reply = await f.get("/assets/big-Cw3HIBcK.js");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-length"]).toBe(String(payload.length));
    expect(reply.body.length).toBe(payload.length);
    expect(reply.body.equals(payload)).toBe(true);
  });
});

describe("conditional and HEAD requests", () => {
  it("answers HEAD with the headers and no body", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/assets/index-BcepHmlG.js", { method: "HEAD" });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength("console.log(1);")));
    expect(reply.headers.etag).toBeDefined();
    expect(reply.body.length).toBe(0);
  });

  it("answers 304 for a matching If-None-Match", async () => {
    const f = await start(makeRoot());
    const first = await f.get("/assets/index-BcepHmlG.js");
    const etag = first.headers.etag as string;
    const reply = await f.get("/assets/index-BcepHmlG.js", { headers: { "if-none-match": etag } });
    expect(reply.status).toBe(304);
    expect(reply.body.length).toBe(0);
    expect(reply.headers.etag).toBe(etag);
  });

  it("answers 304 for a matching If-Modified-Since and 200 for an older one", async () => {
    const f = await start(makeRoot());
    const first = await f.get("/notes.txt");
    const lastModified = first.headers["last-modified"] as string;
    expect((await f.get("/notes.txt", { headers: { "if-modified-since": lastModified } })).status).toBe(304);
    expect((await f.get("/notes.txt", { headers: { "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" } })).status).toBe(200);
  });

  it("ignores a validator that does not match", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/notes.txt", { headers: { "if-none-match": 'W/"deadbeef-0"' } });
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("hello");
  });
});

describe("SPA fallback", () => {
  it("answers an extensionless GET with index.html, never cached under that URL", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/missions/abc");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-cache");
    expect(reply.body.toString()).toContain("workbench");
  });

  it("does not fall back for a path that names a missing file", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/assets/missing-DEadBeef.js");
    expect(reply.status).toBe(404);
    expect(reply.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(reply.body.toString()).not.toContain("workbench");
  });

  it("does not fall back on HEAD", async () => {
    const f = await start(makeRoot());
    expect((await f.get("/missions/abc", { method: "HEAD" })).status).toBe(404);
  });

  it("can be turned off without losing the root document", async () => {
    const f = await start(makeRoot(), { spaFallback: false });
    expect((await f.get("/missions/abc")).status).toBe(404);
    expect((await f.get("/")).status).toBe(200);
  });
});

describe("handing the request back", () => {
  it("returns false for every /api path so the router owns it", async () => {
    const f = await start(makeRoot());
    for (const path of ["/api", "/api/", "/api/v1/health", "/api/v1/agents/hermes", "/API/v1/health", "/api%2Fv1%2Fhealth"]) {
      const reply = await f.get(path);
      expect(reply.status, path).toBe(418);
      expect(reply.body.toString(), path).toBe("router");
    }
  });

  it("returns false for a method other than GET or HEAD", async () => {
    const f = await start(makeRoot());
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect((await f.get("/assets/index-BcepHmlG.js", { method })).status, method).toBe(418);
    }
  });
});

describe("path traversal", () => {
  const attempts = [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2E%2E%2Fsecret.txt",
    "/..%2fsecret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/..\\secret.txt",
    "/assets\\index-BcepHmlG.js",
    "/notes.txt%00.png",
    "/notes%00.txt",
    "/C:/Windows/win.ini",
    "/con",
    "/assets/aux.js",
    "/notes.txt.",
    "/notes.txt%20",
    "//etc/passwd",
    "/%E0%A4%A",
  ];

  it("refuses every attempt without reading outside the root", async () => {
    const f = await start(makeRoot());
    for (const path of attempts) {
      const reply = await f.raw(path);
      expect([400, 403, 404], `${path} -> ${reply.status}`).toContain(reply.status);
      expect(reply.body.toString(), path).not.toContain("root:");
      expect(reply.headers["content-type"], path).toBe("text/plain; charset=utf-8");
    }
  });

  it("refuses a literal parent segment before touching the filesystem", async () => {
    const f = await start(makeRoot());
    const reply = await f.raw("/../package.json");
    expect(reply.status).toBe(400);
  });

  it("refuses a null byte and a backslash as malformed, not as a missing file", async () => {
    const f = await start(makeRoot());
    expect((await f.raw("/notes%00.txt")).status).toBe(400);
    expect((await f.raw("/assets%5Cindex-BcepHmlG.js")).status).toBe(400);
  });
});

describe("symlink escape", () => {
  it.skipIf(!fileSymlinks)("refuses a symlinked file that points outside the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "eac-static-outside-"));
    created.push(outside);
    writeFileSync(join(outside, "secret.txt"), "root: /etc");
    const root = makeRoot();
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    const f = await start(root);
    const reply = await f.get("/leak.txt");
    expect(reply.status).toBe(403);
    expect(reply.body.toString()).not.toContain("root:");
  });

  it.skipIf(!dirSymlinks)("refuses a symlinked directory that points outside the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "eac-static-outside-dir-"));
    created.push(outside);
    writeFileSync(join(outside, "secret.txt"), "root: /etc");
    const root = makeRoot();
    symlinkSync(outside, join(root, "escape"), "junction");
    const f = await start(root);
    const reply = await f.get("/escape/secret.txt");
    expect(reply.status).toBe(403);
    expect(reply.body.toString()).not.toContain("root:");
  });

  it.skipIf(!fileSymlinks)("still serves a symlink that stays inside the root", async () => {
    const root = makeRoot();
    symlinkSync(join(root, "notes.txt"), join(root, "alias.txt"));
    const f = await start(root);
    const reply = await f.get("/alias.txt");
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("hello");
  });
});

describe("errors", () => {
  it("answers a missing file with 404 and no absolute path", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/assets/nope-BcepHmlG.js");
    expect(reply.status).toBe(404);
    const text = reply.body.toString();
    expect(text).not.toContain(f.root);
    expect(text).not.toContain("eac-static-");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["content-security-policy"]).toBe(STATIC_CONTENT_SECURITY_POLICY);
  });

  it("answers 404 when the root itself does not exist", async () => {
    const f = await start(join(tmpdir(), "eac-static-absent-root-does-not-exist"));
    expect((await f.get("/")).status).toBe(404);
    expect((await f.get("/assets/index-BcepHmlG.js")).status).toBe(404);
  });

  it("does not answer a directory as a file", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/assets");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
  });
});

describe("security headers", () => {
  it("carries a policy that fits Astryx, the event stream and Vite's build", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/");
    const csp = reply.headers["content-security-policy"] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'; script");
  });

  it("keeps the policy on assets too", async () => {
    const f = await start(makeRoot());
    const reply = await f.get("/assets/index-BcepHmlG.js");
    expect(reply.headers["content-security-policy"]).toBe(STATIC_CONTENT_SECURITY_POLICY);
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
  });
});
