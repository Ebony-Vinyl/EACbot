// Xiaohongshu's creator-page knowledge: the selectors its web line drives and the shapes it reads back.
//
// Xiaohongshu has no open API for a personal creator account, so publishing goes through the signed-in creator
// page. Everything page-specific lives here; a redesign is a change to this file.

export const PAGES = {
  messages: "https://creator.xiaohongshu.com/new/note-manager",
  publish: "https://creator.xiaohongshu.com/publish/publish",
};

export const SELECTORS = {
  messageList: "[class*='note-list'] [class*='note-item'], [class*='data-list'] > *",
  messageRow: "[class*='note-detail'], [class*='note-content']",
  composer: "textarea, [contenteditable='true']",
  sendButton: "[class*='publish-btn'], button[class*='submit']",
  titleField: "input[placeholder*='标题'], [class*='title'] input",
  imageField: "input[type='file']",
};

const TIME = /(\d{1,2}:\d{2})|(\d{4}-\d{2}-\d{2})|(\d+\s*(?:分钟|小时|天)前)|刚刚/;

export function parseConversations(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (!TIME.test(lines[index])) continue;
    const name = lines[index - 1];
    const preview = lines[index + 1];
    if (!name || !preview) continue;
    rows.push({ conversationId: `${name}::${lines[index]}`.slice(0, 200), name: name.slice(0, 120), preview: preview.slice(0, 200), at: lines[index].slice(0, 40) });
  }
  return rows.slice(0, 100);
}

export function parseThread(text, { selfName } = {}) {
  const messages = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length < 2 || !TIME.test(lines[index + 1] ?? "")) continue;
    messages.push({ text: lines[index].slice(0, 20_000), at: lines[index + 1], isSelf: Boolean(selfName && index > 0 && lines[index - 1] === selfName) });
  }
  return messages.slice(-200);
}

/** The note manager's rows: title, how it did, and what state it is in. */
export function parseItems(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const views = /^(\d+)\s*(?:浏览|次浏览|观看)/.exec(lines[index]);
    if (!views) continue;
    const title = lines[index - 1];
    if (!title) continue;
    rows.push({
      title: title.slice(0, 200),
      views: Number(views[1]),
      status: /审核中|未通过/.test(lines[index + 1] ?? "") ? "pending" : "published",
    });
  }
  return rows.slice(0, 200);
}

export const WEB_ACTIONS = {
  "open-notes": "Open the note manager",
  "read-notes": "Read the note manager",
  "self-check": "Check the selectors still match",
};

export const XHS_WEB_PROFILE = {
  pages: PAGES,
  selectors: SELECTORS,
  parseConversations,
  parseThread,
  parseItems,
  actions: WEB_ACTIONS,
};
