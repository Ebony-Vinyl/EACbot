// The plugin configuration form and its status line, rendered from the same payload the server sends. A saved
// secret must leave no trace in the markup, and a stopped plugin must read as a reason, never as healthy.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { PluginConfigFields, PluginStatusReadout, type PluginConfigResponse, type PluginStatusResponse } from "./PluginConfig";

// `window` is read by the request helper; the status line fetches, the fields do not.
const page = {};

/** The form with values in hand: what a person sees, before any fetch. */
function render(payload: PluginConfigResponse, draft?: Record<string, string>): string {
  vi.stubGlobal("window", page);
  const initial = draft ?? Object.fromEntries(payload.fields.map((field) => {
    const value = payload.values[field.key];
    if (value === undefined || typeof value === "object") return [field.key, ""];
    return [field.key, String(value)];
  }));
  return renderToStaticMarkup(createElement(PluginConfigFields, {
    config: payload,
    draft: initial,
    onDraft: () => {},
    busy: false,
    saved: false,
    error: null,
    onSave: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const QQ_CONFIG: PluginConfigResponse = {
  fields: [
    { key: "onebotUrl", type: "string", description: "OneBot address" },
    { key: "accountId", type: "string", description: "the account id" },
    { key: "onebotToken", type: "string", description: "bridge token", secret: true },
    { key: "pollMs", type: "number", description: "how often" },
  ],
  values: { onebotUrl: "ws://127.0.0.1:3001", accountId: "acc-1", onebotToken: { set: true }, pollMs: 500 },
  missing: [],
  undeclared: [],
};

describe("plugin configuration form", () => {
  it("renders one input per declared field, in the schema's order", () => {
    const html = render(QQ_CONFIG);
    const order = ["onebotUrl", "accountId", "onebotToken", "pollMs"].map((key) => html.indexOf(key));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("shows a stored value as text", () => {
    const html = render(QQ_CONFIG);
    expect(html).toContain("ws://127.0.0.1:3001");
    expect(html).toContain("acc-1");
  });

  it("shows a saved secret as set, with an empty box and no value in the markup", () => {
    const html = render(QQ_CONFIG);
    expect(html).toContain(">set<");
    expect(html).toContain('type="password"');
    // The token never came back from the server, so it cannot be in the form either.
    expect(html).not.toContain("secret-abc");
  });

  it("marks a required field that has no value yet", () => {
    const html = render({ ...QQ_CONFIG, values: { onebotToken: { set: true } }, missing: ["onebotUrl", "accountId"] });
    expect(html).toContain('text-danger">*');
  });

  it("says which stored keys it will drop, instead of deleting them silently", () => {
    const html = render({ ...QQ_CONFIG, undeclared: ["retiredKey"] });
    expect(html).toContain("retiredKey");
  });

  it("renders a plugin with no configuration as a sentence, not an empty form", () => {
    const html = render({ fields: [], values: {}, missing: [], undeclared: [] });
    expect(html).toContain("no configuration");
    expect(html).not.toContain("<input");
  });
});

describe("plugin status line", () => {
  const renderStatus = (status: PluginStatusResponse) =>
    renderToStaticMarkup(createElement(PluginStatusReadout, { status, busy: false, onRefresh: () => {} }));

  it("reads a connected bridge as connected", () => {
    const html = renderStatus({ fields: [], values: { connected: true, inboundDelivered: 3, outboundSent: 2 } });
    expect(html).toContain("Connected");
    expect(html).toContain("received");
    expect(html).toContain("sent");
  });

  it("reads a disconnected bridge as not connected, with the reason it gave", () => {
    const html = renderStatus({ fields: [], values: { connected: false, lastError: "Unexpected server response: 404" } });
    expect(html).toContain("Not connected");
    expect(html).toContain("404");
  });

  it("says why a stopped plugin has no status instead of showing nothing", () => {
    const html = renderStatus({ fields: [], values: {}, error: "the plugin is not running; enable it to see its status" });
    expect(html).toContain("not running");
  });
});
