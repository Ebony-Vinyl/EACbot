import type { HerdrMessage } from "../../../packages/agent-protocol/herdr";
import type { CodexToolKind } from "./CodexToolIcon";

export const TOOL_GROUP_LABELS: Record<CodexToolKind, string> = {
  computer: "操作电脑", browser: "操作浏览器", image: "查看图片", read: "读取文件",
  folder: "列出文件", search: "搜索文件", web: "搜索网页", edit: "修改文件",
  command: "运行命令", agents: "协作 Agent", generic: "工具操作",
};
export interface ToolPresentation { kind: CodexToolKind; label: string }

function classify(name: string, args: Record<string, unknown>): ToolPresentation {
  const tool = name.replace(/^.*(?:__|\.)/, "");
  const path = args.path ?? args.file_path ?? args.filename;
  const suffix = typeof path === "string" && path ? ` ${path}` : "";
  if (/^mcp__(?:cua_repl|computer_use|unified_computer_use|computer)(?:__|\.)/.test(name)
    || /^(computer|computer_use|computer_batch|computer_screenshot|computer_click|computer_type|click|type_text|press_key|scroll)$/.test(tool)) return { kind: "computer", label: "操作电脑" };
  if (/^mcp__(?:browser|playwright)(?:__|\.)/.test(name) || /^(browser|browser_click|browser_navigate|browser_snapshot)$/.test(tool)) return { kind: "browser", label: "操作浏览器" };
  if (tool === "view_image") return { kind: "image", label: `查看图片${suffix}` };
  if (/^(imagegen|generate_image)$/.test(tool)) return { kind: "image", label: "生成图片" };
  if (/^(spawn_agent|send_message|wait_agent|followup_task|interrupt_agent|close_agent|list_agents)$/.test(tool)) return { kind: "agents", label: "协作 Agent" };
  if (/^(apply_patch|edit_file|write_file|replace_in_file)$/.test(tool)) return { kind: "edit", label: `修改文件${suffix}` };
  if (/^(read_file|file_read|read_text_file)$/.test(tool) || name === "file.read") return { kind: "read", label: `读取文件${suffix}` };
  if (/^(list_files|list_directory|list_dir)$/.test(tool)) return { kind: "folder", label: `列出文件${suffix}` };
  if (/^(web_search|search_web)$/.test(tool) || /(?:^|__)web(?:__|\.)/.test(name)) return { kind: "web", label: typeof args.query === "string" ? `搜索网页 ${args.query}` : "检索网页" };
  const command = args.cmd ?? args.command;
  if (typeof command === "string") {
    const label = command.replace(/\s+/g, " ").trim();
    const simple = !/[;&|\n]/.test(command);
    const kind = simple && /^(cat|head|tail|sed)\s/.test(label) ? "read" : simple && /^(rg|grep|find)\s/.test(label) ? "search" : simple && /^ls(?:\s|$)/.test(label) ? "folder" : "command";
    return { kind, label };
  }
  if (/^(search|search_files|grep|glob)$/.test(tool) || typeof args.query === "string") return { kind: "search", label: typeof args.query === "string" ? `搜索 ${args.query}` : "搜索文件" };
  if (/^(exec|exec_command|shell|shell_command|write_stdin)$/.test(tool)) return { kind: "command", label: `运行命令 · ${tool}` };
  return { kind: "generic", label: name };
}

export function toolLabel(message: HerdrMessage): ToolPresentation {
  if (!message.tool) return { kind: "generic", label: message.text.split("\n")[0] ?? "工具操作" };
  const { name, input } = message.tool;
  let args: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(input);
    if (value && typeof value === "object" && !Array.isArray(value)) args = value as Record<string, unknown>;
  } catch { /* Native custom tools carry plain text instead of JSON. */ }
  if (/^(exec|functions\.exec)$/.test(name)) {
    const script = typeof args.code === "string" ? args.code : input;
    const nested = [...script.matchAll(/\btools\.([A-Za-z_]\w*)\s*\(/g)].map(match => classify(match[1]!, {}));
    if (nested.length && nested[0]!.kind !== "generic" && nested.every(item => item.kind === nested[0]!.kind)) return nested[0]!;
  }
  return classify(name, args);
}
