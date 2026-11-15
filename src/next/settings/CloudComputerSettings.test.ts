// @vitest-environment happy-dom
import { createElement as h, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentRecord } from "../personal/port.ts";

const wire = vi.hoisted(() => ({
  create: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  environments: { status: "ready", data: [], refresh: vi.fn() } as Fake<readonly EnvironmentRecord[]>,
}));

vi.mock("../personal/foundation.ts", () => ({
  environmentActions: {
    create: wire.create,
    test: wire.test,
    remove: wire.remove,
  },
  useEnvironments: () => wire.environments,
  actionFailureMessage: (error: unknown) => (error instanceof Error ? error.message : "请求失败"),
}));

const { CloudComputerSettings } = await import("./CloudComputerSettings.tsx");

/** The mocked hooks return these; a test sets the state it wants to exercise
 * without building the transport. */
interface Fake<T> {
  readonly status: string;
  readonly data?: T;
  readonly message?: string;
  readonly retry?: () => void;
  readonly refresh?: () => void;
}

let host: HTMLDivElement;
let root: Root;

const render = (node: ReactNode) => flushSync(() => root.render(node));

beforeEach(() => {
  for (const fn of [wire.create, wire.test, wire.remove]) fn.mockReset();
  wire.environments = { status: "ready", data: [], refresh: vi.fn() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

/** A dialog is rendered into a portal on the document body, so a query for its
 * contents has to look past the mount point. */
const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (node: Element | undefined) => {
  expect(node).toBeDefined();
  flushSync(() => (node as HTMLButtonElement).click());
};
function typeInto(id: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
  expect(field).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
}

async function settle() {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

const record = (overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord => ({
  id: "env-1",
  label: "Office box",
  host: "box.example.com",
  port: 2222,
  user: "deploy",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  status: "online",
  ...overrides,
});

const FINGERPRINT = "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU";

describe("the add-my-computer form", () => {
  it("starts empty and offers to add a computer", () => {
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain("还没有连接任何电脑");
    expect(button("添加我的电脑")).toBeDefined();
  });

  it("shows a field error and sends nothing when the form is incomplete", async () => {
    render(h(CloudComputerSettings));
    click(button("添加我的电脑"));
    click(button("保存并连接"));
    await settle();
    expect(wire.create).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Enter the host name or address");
  });

  it("refuses a root account before it sends anything", async () => {
    render(h(CloudComputerSettings));
    click(button("添加我的电脑"));
    typeInto("computer-label", "Box");
    typeInto("computer-host", "box.example.com");
    typeInto("computer-user", "root");
    typeInto("computer-fingerprint", FINGERPRINT);
    click(button("保存并连接"));
    await settle();
    expect(wire.create).not.toHaveBeenCalled();
    expect(host.textContent).toContain("non-root");
  });

  it("refuses a fingerprint that is not one ssh prints", async () => {
    render(h(CloudComputerSettings));
    click(button("添加我的电脑"));
    typeInto("computer-label", "Box");
    typeInto("computer-host", "box.example.com");
    typeInto("computer-user", "deploy");
    typeInto("computer-fingerprint", "ssh-ed25519 AAAA");
    click(button("保存并连接"));
    await settle();
    expect(wire.create).not.toHaveBeenCalled();
    expect(host.textContent).toContain("SHA256:");
  });

  it("sends connection facts only, with no password or key field anywhere", async () => {
    wire.create.mockResolvedValue(record());
    render(h(CloudComputerSettings));
    click(button("添加我的电脑"));
    typeInto("computer-label", "Office box");
    typeInto("computer-host", "box.example.com");
    typeInto("computer-port", "2222");
    typeInto("computer-user", "deploy");
    typeInto("computer-fingerprint", FINGERPRINT);
    click(button("保存并连接"));
    await settle();

    expect(wire.create).toHaveBeenCalledTimes(1);
    const body = wire.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      label: "Office box",
      host: "box.example.com",
      port: 2222,
      user: "deploy",
      hostKeyFingerprint: FINGERPRINT,
    });
    expect(JSON.stringify(body)).not.toMatch(/password|passphrase|privateKey|keyBody|BEGIN OPENSSH|knownHostsFile|authMode|"kind"/u);
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it("says the request failed instead of pretending the computer was added", async () => {
    wire.create.mockRejectedValue(new Error("the server refused the fingerprint"));
    render(h(CloudComputerSettings));
    click(button("添加我的电脑"));
    typeInto("computer-label", "Office box");
    typeInto("computer-host", "box.example.com");
    typeInto("computer-user", "deploy");
    typeInto("computer-fingerprint", FINGERPRINT);
    click(button("保存并连接"));
    await settle();
    expect(host.textContent).toContain("the server refused the fingerprint");
    expect(host.querySelector("[data-testid='add-computer-form']")).not.toBeNull();
  });
});

describe("a connected computer", () => {
  it("shows the stored fingerprint and the last test result", () => {
    wire.environments = {
      status: "ready",
      data: [record({ lastTest: { reachable: true, latencyMs: 42, checkedAt: "2026-11-15T10:00:00Z" } })],
      refresh: vi.fn(),
    };
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain(FINGERPRINT);
    expect(host.textContent).toContain("42 ms");
  });

  it("reports a failed test with the server's own reason", async () => {
    wire.environments = { status: "ready", data: [record()], refresh: vi.fn() };
    wire.test.mockResolvedValue({ reachable: false, detail: "connection refused", checkedAt: "2026-11-15T10:00:00Z" });
    render(h(CloudComputerSettings));
    click(button("测试连接"));
    await settle();
    expect(wire.test).toHaveBeenCalledWith("env-1");
    expect(host.textContent).toContain("connection refused");
  });

  it("never claims a connection when no transport answered", async () => {
    wire.environments = { status: "ready", data: [record()], refresh: vi.fn() };
    wire.test.mockResolvedValue({ reachable: false, checkedAt: "2026-11-15T10:00:00Z" });
    render(h(CloudComputerSettings));
    click(button("测试连接"));
    await settle();
    expect(host.textContent).toContain("没有任何传输层报告原因");
  });

  it("asks before removing, and names what removal does and does not touch", () => {
    wire.environments = { status: "ready", data: [record()], refresh: vi.fn() };
    render(h(CloudComputerSettings));
    click(button("删除"));
    expect(document.body.textContent).toContain("删除这台电脑？");
    expect(document.body.textContent).toContain("不会被改动");
    expect(wire.remove).not.toHaveBeenCalled();
  });

  it("warns loudly when the stored pin and the presented key disagree", () => {
    wire.environments = { status: "ready", data: [record({ status: "hostKeyChanged" })], refresh: vi.fn() };
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain("主机指纹变了");
    expect(host.textContent).toContain("拦截");
  });
});

describe("a changed host key has no in-place re-pin, so the screen says so", () => {
  it("offers no confirm action of its own", () => {
    wire.environments = { status: "ready", data: [record({ status: "hostKeyChanged" })], refresh: vi.fn() };
    render(h(CloudComputerSettings));
    expect(button("重新确认指纹")).toBeUndefined();
  });

  it("tells the person to remove the record and add the computer again", () => {
    wire.environments = { status: "ready", data: [record({ status: "hostKeyChanged" })], refresh: vi.fn() };
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain("重新添加");
    expect(host.textContent).toContain("核对");
  });

  it("removes the record only after the person confirms the dialog", async () => {
    wire.environments = { status: "ready", data: [record({ status: "hostKeyChanged" })], refresh: vi.fn() };
    wire.remove.mockResolvedValue(undefined);
    render(h(CloudComputerSettings));
    click(button("删除"));
    expect(wire.remove).not.toHaveBeenCalled();
    click([...document.querySelectorAll("button")].filter((node) => node.textContent?.trim() === "删除").pop());
    await settle();
    expect(wire.remove).toHaveBeenCalledWith("env-1");
  });
});

describe("the four states", () => {
  it("shows a loading state while the list is being read", () => {
    wire.environments = { status: "loading" };
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain("正在读取已连接的电脑");
  });

  it("shows the pairing message when the device is not authorised", () => {
    wire.environments = { status: "unauthorized" };
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain("这个设备还没有配对");
  });

  it("shows the failure and a retry when the read failed", () => {
    const retry = vi.fn();
    wire.environments = { status: "error", message: "服务器没有响应", retry };
    render(h(CloudComputerSettings));
    expect(host.textContent).toContain("服务器没有响应");
    click(button("重试"));
    expect(retry).toHaveBeenCalled();
  });
});
