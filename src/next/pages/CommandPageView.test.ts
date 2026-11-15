// @vitest-environment happy-dom
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSnapshot } from "../foundation/http.ts";

/** The command-centre pages fill the shell's main pane, so what matters here is
 * that the shell can mount each one and that an unpaired device gets the one
 * screen that fixes it rather than a pane of 401s. The pages' own behaviour is
 * covered by their own tests. */

const auth = vi.hoisted(() => ({ value: { status: "anonymous", token: null, session: null, error: null } as AuthSnapshot }));

vi.mock("../foundation/api.ts", () => ({ useAuth: () => auth.value }));
vi.mock("../personal/PersonalAgentPage.tsx", () => ({
  PersonalAgentPage: () => h("div", { "data-testid": "page-hermes-stub" }),
}));
vi.mock("../personal/MissionCenter.tsx", () => ({
  MissionCenter: () => h("div", { "data-testid": "page-missions-stub" }),
}));
vi.mock("../settings/CloudComputerSettings.tsx", () => ({
  CloudComputerSettings: () => h("div", { "data-testid": "page-computers-stub" }),
}));
vi.mock("../settings/AgentSettings.tsx", () => ({
  AgentSettings: () => h("div", { "data-testid": "page-agents-stub" }),
}));
vi.mock("../workbench/Workbench.tsx", () => ({
  Workbench: () => h("div", { "data-testid": "page-terminals-stub" }),
}));
vi.mock("./PairingGate.tsx", () => ({
  PairingGate: () => h("div", { "data-testid": "pairing-gate-stub" }),
}));

const { CommandPageView } = await import("./CommandPageView.tsx");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(page: "hermes" | "missions" | "computers" | "agents" | "terminals"): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(CommandPageView, { page })));
  return container;
}

const PAIRED: AuthSnapshot = {
  status: "paired",
  token: "token",
  session: { id: "s1", label: "EACbot", scope: "owner", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  error: null,
};

beforeEach(() => {
  auth.value = { status: "anonymous", token: null, session: null, error: null };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("the command-centre pages", () => {
  it.each([
    ["hermes", "page-hermes-stub"],
    ["missions", "page-missions-stub"],
    ["computers", "page-computers-stub"],
    ["agents", "page-agents-stub"],
    ["terminals", "page-terminals-stub"],
  ] as const)("mounts %s once the device is paired", (page, stub) => {
    auth.value = PAIRED;
    const dom = mount(page);
    expect(dom.querySelector(`[data-testid="${stub}"]`)).not.toBeNull();
    expect(dom.querySelector('[data-testid="pairing-gate-stub"]')).toBeNull();
  });

  it("shows the pairing gate instead of a pane of 401s while unpaired", () => {
    const dom = mount("hermes");
    expect(dom.querySelector('[data-testid="pairing-gate-stub"]')).not.toBeNull();
    expect(dom.querySelector('[data-testid="page-hermes-stub"]')).toBeNull();
  });

  it("fills the shell's main pane with the app's own pane colour", () => {
    auth.value = PAIRED;
    const dom = mount("missions");
    const frame = dom.querySelector('[data-testid="command-page-missions"]');
    expect(frame?.tagName).toBe("MAIN");
    // The background layer makes `bg-app` see-through while a picture is drawn,
    // so the page must use it rather than a colour of its own.
    expect(frame?.className).toContain("bg-app");
  });
});
