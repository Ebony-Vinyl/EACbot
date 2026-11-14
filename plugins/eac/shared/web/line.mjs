// The web line every platform shares: open a page, read it, act on it, and stop on a wall.
//
// A platform hands this a `profile` describing its pages, its selectors and its parsers. Everything else —
// polling, de-duplication, the receipt check after a send, the self-check — is written once here, so a new
// platform adds a profile and no transport code. A wall (a sign-in or a security check) always stops the line
// and is reported as itself: nothing in this file solves a captcha or retries around one.
import { BrowserError } from "./cdp.mjs";

const WALLS = [
  { kind: "verify", pattern: /请完成验证|安全验证|滑动验证|拖动滑块|验证码|访问受限|punish|captcha|verify you are human/i },
  { kind: "login", pattern: /请登录|扫码登录|登录后查看|passport|sign in to continue/i },
];

/** Which wall a page is showing, if any. */
export function wallOf(text) {
  const page = String(text ?? "");
  for (const wall of WALLS) if (wall.pattern.test(page)) return wall.kind;
  return null;
}

/** A failing probe always explains itself, so a person learns what broke rather than that something did. */
export function selfCheckReport(probes) {
  return probes.map((probe) => {
    const wall = wallOf(probe.text);
    return {
      probe: probe.probe,
      ok: Boolean(probe.matched) && !wall,
      wall,
      reason: wall === "verify" ? "The page asked for a security check; answer it in the browser yourself."
        : wall === "login" ? "The page asked for a sign-in; the browser's session for this site has lapsed."
        : probe.matched ? "Matched." : "Nothing matched: the page layout has probably changed.",
    };
  });
}

/** A stable key for one message, so a poll that sees the same thread twice does not deliver it twice. */
export function messageKey(conversationId, at, text) {
  return `${conversationId}:${at}:${String(text ?? "").slice(0, 40)}`;
}

/**
 * @param profile `{ pages, selectors, parseConversations, parseThread, parseItems?, parseOrders?, actions }`
 * @param browser `{ act(action, params) }` — the CDP driver, or a stand-in in a test.
 */
export function createPageTransport({ profile, browser, accountId, pollMs = 20_000, now = () => Date.now() }) {
  let timer = null;
  let closed = false;
  let onEvent = null;
  let polling = false;
  const seen = new Set();
  const state = { connected: false, lastError: null, fatal: false, read: 0, sent: 0, lastPollAt: null, selfCheck: null, conversations: 0 };

  const act = async (action, params) => {
    if (!browser?.act) throw new BrowserError("no-browser", "This build cannot drive a browser, so the web line is unavailable.", false);
    return browser.act(action, params);
  };

  const fail = (error) => {
    state.lastError = String(error instanceof Error ? error.message : error).slice(0, 400);
    if (error?.code === "no-browser" || error?.code === "login" || error?.code === "verify") state.fatal = true;
    return error;
  };

  const wallError = (wall, where) => fail(new BrowserError(
    wall,
    wall === "verify"
      ? `${where} asked for a security check; answer it in the browser yourself.`
      : `${where} asked for a sign-in; the browser's session for this site has lapsed.`,
    false,
  ));

  async function readConversations() {
    await act("open", { url: profile.pages.messages });
    const answer = await act("read", { selector: profile.selectors.messageList });
    const wall = wallOf(answer?.text);
    if (wall) throw wallError(wall, "The message page");
    return profile.parseConversations(answer?.text);
  }

  async function readThread(conversation) {
    await act("click", { selector: profile.selectors.messageList, text: conversation.name });
    const answer = await act("read", { selector: profile.selectors.messageRow });
    const wall = wallOf(answer?.text);
    if (wall) throw wallError(wall, "The conversation");
    return profile.parseThread(answer?.text, { selfName: conversation.selfName });
  }

  async function poll() {
    if (closed || polling) return;
    polling = true;
    try {
      const conversations = await readConversations();
      state.connected = true;
      state.lastPollAt = new Date(now()).toISOString();
      state.conversations = conversations.length;
      for (const conversation of conversations) {
        if (seen.has(conversation.conversationId)) continue;
        seen.add(conversation.conversationId);
        for (const message of await readThread(conversation)) {
          const key = messageKey(conversation.conversationId, message.at, message.text);
          if (seen.has(key) || message.isSelf) continue;
          seen.add(key);
          state.read += 1;
          onEvent?.({
            conversationId: conversation.conversationId,
            messageId: key,
            text: message.text,
            senderId: conversation.conversationId,
            senderName: conversation.name,
            receivedAt: new Date(now()).toISOString(),
            isSelf: false,
          });
        }
      }
      if (seen.size > 5_000) {
        for (const key of [...seen].slice(0, seen.size - 2_000)) seen.delete(key);
      }
    } catch (error) {
      state.connected = false;
      fail(error);
    } finally {
      polling = false;
    }
  }

  return {
    name: "web",
    async start(handler) {
      onEvent = handler;
      closed = false;
      try {
        await readConversations();
        state.connected = true;
      } catch (error) {
        fail(error);
      }
      timer = setInterval(() => { void poll(); }, Math.max(5_000, pollMs));
      timer.unref?.();
    },
    async stop() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      state.connected = false;
    },
    /** Sends one reply and proves it landed: the page is the receipt, not the click. */
    async send(message) {
      await act("open", { url: profile.pages.messages });
      await act("click", { selector: profile.selectors.messageList, text: message.conversationName ?? "" });
      const before = await act("read", { selector: profile.selectors.messageRow });
      const wall = wallOf(before?.text);
      if (wall) throw wallError(wall, "The conversation");
      await act("fill", { selector: profile.selectors.composer, text: message.text });
      const clicked = await act("click", { selector: profile.selectors.sendButton });
      if (clicked?.ok === false) throw new BrowserError("not-sent", clicked.reason ?? "The send control did not take the text.", false);
      const after = await act("read", { selector: profile.selectors.messageRow });
      if (!String(after?.text ?? "").includes(String(message.text).slice(0, 20))) {
        throw new BrowserError("no-receipt", "The reply is not in the thread after sending; its result is unknown.", false);
      }
      state.sent += 1;
      return { ok: true };
    },
    async readItems() {
      if (!profile.parseItems || !profile.pages.items) throw new BrowserError("no-items", "This platform has no listing page.", false);
      await act("open", { url: profile.pages.items });
      const answer = await act("read", { selector: profile.selectors.itemCard });
      return profile.parseItems(answer?.text);
    },
    async readOrders() {
      if (!profile.parseOrders || !profile.pages.orders) throw new BrowserError("no-orders", "This platform has no order page.", false);
      await act("open", { url: profile.pages.orders });
      const answer = await act("read", { selector: profile.selectors.orderRow });
      return profile.parseOrders(answer?.text);
    },
    async selfCheck() {
      const probes = [];
      for (const [probe, selector] of Object.entries(profile.selectors)) {
        try {
          const answer = await act("probe", { selector });
          probes.push({ probe, matched: answer?.matched === true, text: answer?.text ?? "" });
        } catch (error) {
          probes.push({ probe, matched: false, text: String(error?.message ?? "") });
        }
      }
      state.selfCheck = selfCheckReport(probes);
      return state.selfCheck;
    },
    actions: profile.actions,
    state() {
      return {
        mode: "web",
        connected: state.connected,
        fatal: state.fatal,
        lastError: state.lastError,
        lastPollAt: state.lastPollAt,
        read: state.read,
        sent: state.sent,
        conversations: state.conversations,
        selfCheck: state.selfCheck,
        accountId,
      };
    },
  };
}
