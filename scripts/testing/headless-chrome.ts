// One page of a headless Chrome in a throwaway profile, driven over the DevTools protocol, for the verify-* scripts that
// photograph a Vite preview.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitForExit } from "../../server/testing/cleanup.ts";

export const CHROME_PATH = process.env.EAC_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface HeadlessPage {
  debuggerUrl: string;
  events: Array<{ method: string; params: unknown }>;
  send: (method: string, params?: object) => Promise<any>;
  /** The expression's value, awaited when it is a promise. */
  evaluate: (expression: string) => Promise<any>;
  /** Waits until `condition` (an expression) is true, or throws after `timeoutMs`. */
  until: (condition: string, timeoutMs?: number) => Promise<void>;
  /** A PNG of the page, or of `clip` in CSS pixels. */
  capture: (clip?: { x: number; y: number; width: number; height: number }) => Promise<Buffer>;
  close: () => void;
  closeAndWait: () => Promise<void>;
}

export async function openHeadlessChrome(profile: string): Promise<HeadlessPage> {
  const chrome = spawn(CHROME_PATH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", windowsHide: true });
  let spawnError: Error | undefined;
  chrome.once("error", (error) => { spawnError = error; });
  let socket: WebSocket;
  let debuggerUrl = "";
  try {
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      await delay(100);
      if (spawnError) throw spawnError;
      if (chrome.exitCode !== null || chrome.signalCode !== null) {
        throw new Error(`Browser exited before DevTools was ready (${chrome.exitCode ?? chrome.signalCode})`);
      }
      try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
    }
    if (!port) throw new Error("Browser did not report a DevTools port");
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`DevTools target list returned ${response.status}`);
    const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((candidate) => candidate.type === "page");
    if (!target) throw new Error("DevTools did not report a page target");
    debuggerUrl = target.webSocketDebuggerUrl;
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => { socket.close(); fail(new Error("DevTools handshake timed out")); }, 5_000);
      socket.onopen = () => { clearTimeout(timer); done(); };
      socket.onerror = () => { clearTimeout(timer); fail(new Error("DevTools handshake failed")); };
    });
  } catch (error) {
    if (chrome.pid) await waitForExit(chrome, { signal: "SIGTERM" });
    throw error;
  }
  let next = 0;
  const events: HeadlessPage["events"] = [];
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (["Runtime.exceptionThrown", "Runtime.consoleAPICalled", "Log.entryAdded", "Network.loadingFailed"].includes(message.method)) events.push(message);
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  socket.onclose = () => {
    for (const call of waiting.values()) call.fail(new Error("DevTools connection closed"));
    waiting.clear();
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    waiting.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return {
    debuggerUrl,
    events,
    send,
    evaluate,
    async until(condition, timeoutMs = 60_000) {
      const end = Date.now() + timeoutMs;
      while (!(await evaluate(`Boolean(${condition})`).catch(() => false))) {
        if (Date.now() > end) throw new Error(`${condition} never held (${await evaluate("document.querySelector('main')?.textContent?.slice(0, 120) ?? ''").catch(() => "")})`);
        await delay(250);
      }
    },
    async capture(clip) {
      const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      return Buffer.from(data, "base64");
    },
    close() { socket.close(); chrome.kill(); },
    async closeAndWait() {
      const closed = new Promise<void>((done) => chrome.once("close", () => done()));
      if (socket.readyState === WebSocket.OPEN) {
        const id = ++next;
        socket.send(JSON.stringify({ id, method: "Browser.close" }));
      }
      await waitForExit(chrome);
      socket.close();
      if (chrome.exitCode === null && chrome.signalCode === null) {
        await Promise.race([closed, delay(10_000, undefined, { ref: false })]);
        if (chrome.exitCode === null && chrome.signalCode === null) throw new Error(`Browser process ${chrome.pid} did not exit`);
      }
    },
  };
}
