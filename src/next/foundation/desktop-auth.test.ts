// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { apiClient, authSnapshot, connectDesktopCore } from "./http";

afterEach(() => { delete window.ogb; vi.unstubAllGlobals(); });

it("uses desktop credentials only in memory and adopts a restarted core before the next request", async () => {
  const connection = { baseUrl: "http://127.0.0.1:18001/api/v1", token: "desktop-first-token", session: { id: "desktop", label: "Desktop", scope: "owner" as const, expiresAt: "2099-01-01T00:00:00.000Z" } };
  window.ogb = { taskCore: { connect: vi.fn(async () => connection) } } as unknown as NonNullable<Window["ogb"]>;
  const stored = localStorage.getItem("eacbot.workbench.session.v1");
  const fetcher = vi.fn(async () => new Response('{"agents":[]}', { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  await connectDesktopCore();
  expect(authSnapshot().status).toBe("paired");
  expect(localStorage.getItem("eacbot.workbench.session.v1")).toBe(stored);
  connection.baseUrl = "http://127.0.0.1:18002/api/v1";
  connection.token = "desktop-after-restart";
  await apiClient().request("/agents");
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:18002/api/v1/agents", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer desktop-after-restart" }) }));
  expect(apiClient().baseUrl).toBe(connection.baseUrl);
});
