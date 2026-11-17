// Tieba's page knowledge: the selectors its web line drives and the shapes it reads back.
//
// Tieba has no open read API, so both its reading and its posting go through the signed-in pages. All of the
// page-specific knowledge lives here; a redesign is a change to this file and nothing else.

export const PAGES = {
  messages: "https://tieba.baidu.com/index.html",
  forums: "https://tieba.baidu.com/index.html",
  replies: "https://tieba.baidu.com/i/sys/jump?type=reply",
};

export const SELECTORS = {
  messageList: "[class*='message-list'] [class*='item'], [class*='notice-list'] > *",
  messageRow: "[class*='message-content'], [class*='reply-item']",
  composer: "textarea, [contenteditable='true']",
  sendButton: "[class*='send-btn'], button[class*='send'], [class*='submit']",
  forumThread: "[class*='j_thread_list'], [class*='thread-item']",
  threadFloor: "[class*='l_post'], [class*='post-item']",
};

const TIME = /(\d{1,2}:\d{2})|(\d{4}-\d{2}-\d{2})|(\d+\s*(?:分钟|小时|天)前)|刚刚/;

/** The reply inbox as rows: who wrote, what about, and when. */
export function parseConversations(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!TIME.test(line)) continue;
    const name = lines[index - 1];
    const preview = lines[index + 1];
    if (!name || !preview) continue;
    rows.push({
      conversationId: `${name}::${line}`.slice(0, 200),
      name: name.slice(0, 120),
      preview: preview.slice(0, 200),
      at: line.slice(0, 40),
    });
  }
  return rows.slice(0, 100);
}

export function parseThread(text, { selfName } = {}) {
  const messages = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length < 2) continue;
    if (!TIME.test(lines[index + 1] ?? "")) continue;
    messages.push({
      text: line.slice(0, 20_000),
      at: lines[index + 1],
      isSelf: Boolean(selfName && index > 0 && lines[index - 1] === selfName),
    });
  }
  return messages.slice(-200);
}

/** A forum's threads: title, author, how many answered. */
export function parseItems(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const replies = /^(\d+)\s*(?:回复|条回复)/.exec(lines[index]);
    if (!replies) continue;
    const title = lines[index - 1];
    if (!title) continue;
    rows.push({
      title: title.slice(0, 200),
      replies: Number(replies[1]),
      author: lines[index + 1]?.slice(0, 60) ?? null,
      status: "open",
    });
  }
  return rows.slice(0, 200);
}

/** Floors of one thread, so the board can show what was said without opening the page. */
export function parseOrders(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const floor = /^(\d+)\s*楼/.exec(lines[index]);
    if (!floor) continue;
    const body = lines[index + 1];
    if (!body) continue;
    rows.push({ title: body.slice(0, 200), floor: Number(floor[1]), state: "visible" });
  }
  return rows.slice(0, 200);
}

export const WEB_ACTIONS = {
  "open-messages": "Open the reply inbox",
  "read-conversations": "Read the reply inbox",
  "read-thread": "Read one conversation",
  "send-message": "Send a reply",
  "read-items": "Read a forum's threads",
  "self-check": "Check the selectors still match",
};

export const TIEBA_WEB_PROFILE = {
  pages: PAGES,
  selectors: SELECTORS,
  parseConversations,
  parseThread,
  parseItems,
  parseOrders,
  actions: WEB_ACTIONS,
};
