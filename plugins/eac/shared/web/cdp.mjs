// A small CDP driver: enough to open a page, read its text, click, type and probe a selector.
//
// It speaks the DevTools protocol over the WebSocket Node already provides, so a web line needs no browser
// library and no copy of the app's browser layer. A person points `cdpUrl` at a Chrome with remote debugging;
// nothing here launches a browser of its own, because a browser this process started would not carry their
// sign-in.
//
// Shared by every platform's web line. A platform supplies selectors and parsers, never transport plumbing.
export class BrowserError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1_500;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BrowserError("timeout", `${what} took longer than ${Math.round(ms / 1000)}s`, true)), ms);
      timer.unref?.();
    }),
  ]);
}

const PROBE_JS = (selector) => `(() => {
  try {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const text = nodes.map((node) => node.innerText ?? node.textContent ?? "").join("\\n").trim();
    return { matched: nodes.length > 0, text: text.slice(0, 200000), count: nodes.length };
  } catch (error) {
    return { matched: false, text: String(error && error.message || error) };
  }
})()`;

const CLICK_JS = (selector, text) => `(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const target = ${text ? `nodes.find((node) => (node.innerText ?? "").includes(${JSON.stringify(text)}))` : "nodes[0]"};
  if (!target) return { ok: false, reason: "no element matched" };
  target.click();
  return { ok: true };
})()`;

const FILL_JS = (selector, value) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return { ok: false, reason: "no field matched" };
  node.focus();
  if ("value" in node) {
    const proto = Object.getPrototypeOf(node);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(node, ${JSON.stringify(value)});
    else node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    node.textContent = ${JSON.stringify(value)};
    node.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
  return { ok: true };
})()`;

export function createCdpBrowser({ cdpUrl }) {
  let socket = null;
  let sequence = 1;
  let session = null;
  const waiting = new Map();

  const send = (method, params = {}, sessionId) => {
    if (!socket || socket.readyState !== 1) throw new BrowserError("no-browser", "The DevTools connection is not open.", true);
    const id = sequence++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  async function connect() {
    if (socket && socket.readyState === 1) return;
    if (!cdpUrl) throw new BrowserError("no-browser", "No cdpUrl is configured, so the web line cannot open a page.", false);
    const opened = new WebSocket(cdpUrl);
    await withTimeout(new Promise((resolve, reject) => {
      opened.addEventListener("open", resolve, { once: true });
      opened.addEventListener("error", () => reject(new BrowserError("no-browser", `The DevTools endpoint at ${cdpUrl} refused the connection.`, false)), { once: true });
    }), CONNECT_TIMEOUT_MS, "connecting to DevTools");
    socket = opened;
    opened.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.id === undefined) return;
      const pending = waiting.get(frame.id);
      if (!pending) return;
      waiting.delete(frame.id);
      if (frame.error) pending.reject(new BrowserError("cdp", `${frame.error.message ?? "the page refused the call"}`, false));
      else pending.resolve(frame.result);
    });
    opened.addEventListener("close", () => {
      for (const [, pending] of waiting) pending.reject(new BrowserError("no-browser", "The DevTools connection closed.", true));
      waiting.clear();
      socket = null;
      session = null;
    });
  }

  async function attach() {
    await connect();
    if (session) return session;
    const created = await send("Target.createTarget", { url: "about:blank" });
    const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    session = attached.sessionId;
    await send("Page.enable", {}, session);
    return session;
  }

  async function evaluate(expression) {
    const attached = await attach();
    const answer = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, attached);
    if (answer?.exceptionDetails) throw new BrowserError("cdp", answer.exceptionDetails.text ?? "the page threw", false);
    return answer?.result?.value;
  }

  return {
    async act(action, params = {}) {
      if (action === "open") {
        const attached = await attach();
        await send("Page.navigate", { url: params.url }, attached);
        // The page decides when it is done; a short settle beats waiting for a network that never idles.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        return { ok: true };
      }
      if (action === "read" || action === "probe") return evaluate(PROBE_JS(params.selector));
      if (action === "click") return evaluate(CLICK_JS(params.selector, params.text));
      if (action === "fill") return evaluate(FILL_JS(params.selector, params.text ?? ""));
      if (action === "url") return evaluate("location.href");
      throw new BrowserError("cdp", `unknown page action ${String(action).slice(0, 40)}`, false);
    },
    async close() {
      if (socket) {
        try { socket.close(); } catch { /* already closed */ }
      }
      socket = null;
      session = null;
    },
    state() {
      return { connected: Boolean(socket && socket.readyState === 1), cdpUrl: cdpUrl ?? null };
    },
  };
}
