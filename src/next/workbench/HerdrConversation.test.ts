// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { toolLabel } from "./herdr-tool-presentation";

it("identifies image tools inside exec without calling a failed invocation successful", () => {
  const image = toolLabel({ id: "i", role: "tool", text: "", tool: { name: "exec", input: 'const result = await tools.view_image({path:""});\nimage(result.image_url);', output: "Script failed" } });
  expect(image.kind).toBe("image");
  expect(image.label).toBe("查看图片");
  const command = toolLabel({ id: "c", role: "tool", text: "", tool: { name: "exec", input: '{"cmd":"pnpm build"}' } });
  expect(command.kind).toBe("command");
  expect(command.label).toBe("pnpm build");
});

it.each([
  ["mcp__cua_repl__js", "computer"],
  ["mcp__cua_repl.js", "computer"],
  ["computer_screenshot", "computer"],
  ["mcp__playwright__browser_navigate", "browser"],
  ["read_file", "read"],
  ["list_directory", "folder"],
  ["apply_patch", "edit"],
  ["web_search", "web"],
  ["spawn_agent", "agents"],
  ["mcp__computer_history__search", "search"],
])("maps %s to its activity icon", (name, kind) => {
  expect(toolLabel({ id: "x", role: "tool", text: "", tool: { name, input: "{}" } }).kind).toBe(kind);
});

it("recognizes wrapped computer use and keeps mixed calls generic", () => {
  const message = { id: "x", role: "tool" as const, text: "", tool: { name: "exec", input: "await tools.mcp__cua_repl__js({code: '...'});" } };
  expect(toolLabel(message).kind).toBe("computer");
  message.tool.input += "await tools.exec_command({cmd: 'ls'});";
  expect(toolLabel(message).kind).toBe("command");
});
