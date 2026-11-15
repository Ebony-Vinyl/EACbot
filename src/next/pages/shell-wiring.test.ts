// @vitest-environment happy-dom
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";

/** The five command-centre pages as a person reaches them: the shell's own rail
 * row, then the pane. This is the wiring the two halves of the change share —
 * the store's new view values and the sidebar's rows — so it is checked where
 * they meet rather than in either half alone. */

const auth = vi.hoisted(() => ({ paired: false }));

vi.mock("@/next/foundation/api.ts", () => ({ useAuth: () => ({ status: auth.paired ? "paired" : "anonymous" }) }));
vi.mock("@/next/pages/PairingGate.tsx", () => ({
  PairingGate: () => h("div", { "data-testid": "pairing-gate-stub" }),
}));
vi.mock("@/next/personal/PersonalAgentPage.tsx", () => ({
  PersonalAgentPage: () => h("div", { "data-testid": "page-hermes-stub" }),
}));
vi.mock("@/next/personal/MissionCenter.tsx", () => ({
  MissionCenter: () => h("div", { "data-testid": "page-missions-stub" }),
}));
vi.mock("@/next/settings/CloudComputerSettings.tsx", () => ({
  CloudComputerSettings: () => h("div", { "data-testid": "page-computers-stub" }),
}));
vi.mock("@/next/settings/AgentSettings.tsx", () => ({
  AgentSettings: () => h("div", { "data-testid": "page-agents-stub" }),
}));
vi.mock("@/next/workbench/Workbench.tsx", () => ({
  Workbench: () => h("div", { "data-testid": "page-terminals-stub" }),
}));

const { CommandPageView } = await import("@/next/pages/CommandPageView.tsx");
const { NEW_PAGES } = await import("@/state/store");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

beforeEach(() => {
  auth.paired = true;
});

describe("the store's page list and the page component", () => {
  it("names the same five pages on both sides, so a rail row always has a page", () => {
    expect([...NEW_PAGES]).toEqual(["hermes", "missions", "computers", "agents", "terminals"]);
  });

  it.each([
    ["hermes", "page-hermes-stub"],
    ["missions", "page-missions-stub"],
    ["computers", "page-computers-stub"],
    ["agents", "page-agents-stub"],
    ["terminals", "page-terminals-stub"],
  ] as const)("mounts %s from the list", (page, stub) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(h(CommandPageView, { page })));
    expect(container.querySelector(`[data-testid="${stub}"]`)).not.toBeNull();
  });

  it("mounts inside the app's own store, so a page reads the same config the shell does", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        h(StoreProvider, null, h(CommandPageView, { page: "missions" })),
      ),
    );
    expect(container.querySelector('[data-testid="page-missions-stub"]')).not.toBeNull();
  });
});
