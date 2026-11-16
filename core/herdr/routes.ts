import type { HerdrSessions } from "./sessions.ts";
import type { Router } from "../http/router.ts";
import { readJsonBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { optionalString, rejectUnknownFields, requireObject, requireOneOf, requireString } from "../http/validate.ts";
import { TOOL_NAMES } from "../environments/types.ts";

export function registerHerdrRoutes(router: Router, sessions: HerdrSessions): void {
  router.get("/api/v1/herdr/sessions", "readonly", () => ({ status: 200, body: { sessions: sessions.list() } }));
  router.post("/api/v1/herdr/sessions", "device", async context => {
    const body = requireObject(await readJsonBody(context.req));
    rejectUnknownFields(body, ["project", "tool", "title"]);
    const session = await operation(() => sessions.create({
      project: requireString(body, "project", { maxLength: 4096 }),
      tool: requireOneOf(body, "tool", TOOL_NAMES),
      title: optionalString(body, "title", { maxLength: 200 }) ?? "",
    }));
    return { status: 201, body: { session } };
  });
  router.get("/api/v1/herdr/sessions/:id/conversation", "readonly", async context => ({ status: 200, body: await operation(() => sessions.conversation(context.params.id!)) }));
  router.get("/api/v1/herdr/sessions/:id/messages/:messageId/images/:offset", "readonly", async context => ({ status: 200, body: await operation(() => sessions.image(context.params.id!, context.params.messageId!, Number(context.params.offset))), headers: { "Cache-Control": "no-store" } }));
  router.post("/api/v1/herdr/sessions/:id/messages", "device", async context => {
    const body = requireObject(await readJsonBody(context.req));
    rejectUnknownFields(body, ["text"]);
    const text = requireString(body, "text", { maxLength: 32000 });
    if (!text.trim()) throw new ApiError("invalid_params", "消息不能为空", 400);
    await operation(() => sessions.send(context.params.id!, text));
    return { status: 200, body: { accepted: true } };
  });
  for (const action of ["interrupt", "end"] as const) router.post(`/api/v1/herdr/sessions/:id/${action}`, "device", async context => {
    await operation(() => sessions[action](context.params.id!));
    return { status: 200, body: { accepted: true } };
  });

}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw new ApiError("herdr_unavailable", error instanceof Error ? error.message : "Herdr 服务不可用", 502); }
}
