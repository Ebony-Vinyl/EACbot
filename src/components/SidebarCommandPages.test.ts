import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The command-centre rows. They sit beside Inbox rather than in the Tools
 * section, because Tools is Advanced-only: a person in Simple mode still needs
 * a way into the personal agent and the task list. */

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  activeView: "chat",
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { activeView: fixture.activeView }, dispatch: fixture.dispatch }),
  NEW_PAGES: ["hermes", "missions", "computers", "agents", "terminals"],
}));

const { SidebarCommandPages } = await import("./SidebarCommandPages");

function render(icons: boolean, large = false): string {
  return renderToStaticMarkup(createElement(SidebarCommandPages, { icons, large }));
}

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.activeView = "chat";
  vi.stubGlobal("window", {});
});

afterEach(() => vi.unstubAllGlobals());

describe("the command-centre rows", () => {
  it("lists every page the store names, in the store's order", () => {
    const html = render(false);
    const pages = ["hermes", "missions", "computers", "agents", "terminals"];
    const positions = pages.map((page) => html.indexOf(`data-sidebar-page="${page}"`));
    expect(positions.every((at) => at >= 0), `missing a page: ${positions.join()}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("carries the words in the row density and the label alone in the icons density", () => {
    expect(render(false)).toContain(">Hermes</span>");
    const icons = render(true);
    expect(icons).not.toContain(">Hermes</span>");
    expect(icons).toContain('aria-label="Hermes"');
    expect(icons).toContain('title="Hermes"');
  });

  it("marks the open page and no other", () => {
    fixture.activeView = "missions";
    const html = render(false);
    expect(html).toMatch(/aria-current="page"[^>]*data-sidebar-page="missions"|data-sidebar-page="missions"[^>]*aria-current="page"/u);
    for (const other of ["hermes", "computers", "agents", "terminals"]) {
      const at = html.indexOf(`data-sidebar-page="${other}"`);
      expect(html.slice(Math.max(0, at - 400), at)).not.toContain('aria-current="page"');
    }
  });

  it("is a nav landmark, so a screen reader can reach it by name", () => {
    expect(render(false)).toMatch(/<nav[^>]*data-sidebar-command-pages/u);
  });
});
