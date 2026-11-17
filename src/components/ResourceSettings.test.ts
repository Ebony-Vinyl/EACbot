// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/next/foundation/api", () => ({ useAuth: () => ({ status: "paired" }) }));
vi.mock("@/next/pages/PairingGate", () => ({ PairingGate: () => null }));
vi.mock("@/next/settings/AgentSettings", () => ({ AgentSettings: () => h("p", null, "agent-panel") }));
vi.mock("@/next/settings/CloudComputerSettings", () => ({ CloudComputerSettings: () => h("p", null, "computer-panel") }));
vi.mock("@/next/workbench/Workbench", () => ({ Workbench: () => h("p", null, "terminal-panel") }));
vi.mock("./FilesView", () => ({ FilesView: () => h("p", null, "files-panel") }));
vi.mock("./platforms/PlatformCenter", () => ({ PlatformCenter: ({ onConnect, onOpen }: { onConnect(): void; onOpen(id: string): void }) => h("div", null,
  h("button", { onClick: onConnect }, "connect-account"), h("button", { onClick: () => onOpen("xianyu") }, "platform-details")) }));
vi.mock("./platforms/PlatformDashboard", () => ({ PlatformDashboard: () => h("p", null, "platform-detail-panel") }));
vi.mock("./PlatformAccountsPanel", () => ({ PlatformAccountsPanel: ({ embedded, onClose }: { embedded: boolean; onClose(): void }) => h("button", { onClick: onClose }, embedded ? "embedded-accounts" : "external-accounts") }));
const { ResourceSettings } = await import("./ResourceSettings");
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("switches all resource content inside settings, including account setup and platform details", async () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(h(ResourceSettings)); });
  for (const [id, marker] of [["agents", "agent-panel"], ["computers", "computer-panel"], ["terminals", "terminal-panel"], ["files", "files-panel"], ["platforms", "connect-account"]]) {
    await act(async () => { host.querySelector<HTMLButtonElement>(`[data-settings-resource="${id}"]`)!.click(); });
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain(marker);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5);
  }
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="tabpanel"] button')!.click(); });
  expect(host.textContent).toContain("embedded-accounts");
  await act(async () => { host.querySelector<HTMLButtonElement>('[role="tabpanel"] button')!.click(); });
  await act(async () => { host.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] button')[1]!.click(); });
  expect(host.textContent).toContain("platform-detail-panel");
});
