// Xianyu's page knowledge: the selectors its web line drives and the shapes it reads back.
//
// All of it lives here, so a redesign is a change to this file and nothing else. Every parser takes the text a
// page action returned and answers plain data; a selector that stops matching yields nothing and the line
// reports "no match" instead of inventing a conversation.

export const PAGES = {
  messages: "https://www.goofish.com/im",
  items: "https://www.goofish.com/personal",
  orders: "https://www.goofish.com/order-list",
};

export const SELECTORS = {
  messageList: "[class*='conversation-list'] [class*='conversation-item'], [class*='msg-list'] > *",
  messageRow: "[class*='message-item'], [class*='msg-item']",
  composer: "textarea, [contenteditable='true']",
  sendButton: "[class*='send-btn'], button[class*='send']",
  itemCard: "[class*='item-card'], [class*='feeds-item']",
  orderRow: "[class*='order-item'], [class*='order-card']",
};

const TIME = /(\d{1,2}:\d{2})|(\d{4}-\d{2}-\d{2})|(\d+\s*(?:分钟|小时|天)前)|刚刚/;

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

export function parseItems(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const price = /^¥\s*([\d.]+)/.exec(lines[index]);
    if (!price) continue;
    const title = lines[index - 1];
    if (!title) continue;
    rows.push({
      title: title.slice(0, 200),
      price: Number(price[1]),
      status: /已下架|已卖出/.test(lines[index + 1] ?? "") ? "closed" : "on-sale",
    });
  }
  return rows.slice(0, 200);
}

export function parseOrders(text) {
  const rows = [];
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const price = /^¥\s*([\d.]+)/.exec(lines[index]);
    if (!price) continue;
    const title = lines[index - 1];
    if (!title) continue;
    const state = lines.slice(index + 1, index + 4).find((line) => /待发货|待付款|已发货|已完成|退款|待收货/.test(line)) ?? "unknown";
    rows.push({ title: title.slice(0, 200), price: Number(price[1]), state });
  }
  return rows.slice(0, 200);
}

/** The page actions this line can drive, so the board lists exactly what exists. */
export const WEB_ACTIONS = {
  "open-messages": "Open the message list",
  "read-conversations": "Read the conversation list",
  "read-thread": "Read one conversation",
  "send-message": "Send a reply",
  "read-items": "Read the listings",
  "read-orders": "Read the orders",
  "self-check": "Check the selectors still match",
};

export const XIANYU_WEB_PROFILE = {
  pages: PAGES,
  selectors: SELECTORS,
  parseConversations,
  parseThread,
  parseItems,
  parseOrders,
  actions: WEB_ACTIONS,
};
