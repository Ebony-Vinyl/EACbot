import { readHerdrImage } from "./images.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HerdrSession, HerdrConversation } from "../../packages/agent-protocol/herdr.ts";
import type { EnvironmentRecord, ToolName } from "../environments/types.ts";
import type { TerminalService } from "../terminal/service.ts";
import { codexMessages, findCodexTranscript } from "./transcript.ts";

type SessionRecord = HerdrSession & { transcript?: string; threadId?: string; socket?: string; serverTerminalId?: string; runtimeDir?: string };

export class HerdrSessions {
  readonly #records: SessionRecord[];
  readonly #file: string;
  readonly #home: string;
  readonly terminals: TerminalService;
  readonly local: EnvironmentRecord;
  constructor(terminals: TerminalService, local: EnvironmentRecord, directory: string) {
    this.terminals = terminals; this.local = local;
    this.#file = join(directory, "herdr-sessions.json");
    this.#home = process.env.CODEX_HOME || join(local.capabilities.homeDir!, ".codex");
    const saved: unknown = existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, "utf8")) : [];
    if (!Array.isArray(saved)) throw new Error("Herdr 会话文件格式错误");
    this.#records = saved.map(value => {
      if (!value || typeof value !== "object") throw new Error("Herdr 会话记录格式错误");
      for (const field of ["id", "title", "project", "tool", "terminalId", "createdAt"]) if (typeof value[field] !== "string") throw new Error(`Herdr 会话缺少 ${field}`);
      for (const field of ["transcript", "threadId", "socket", "serverTerminalId", "runtimeDir", "endedAt"]) if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`Herdr 会话 ${field} 格式错误`);
      return value as SessionRecord;
    });
  }
  list(): HerdrSession[] {
    return this.#records.map(({ transcript, threadId, socket, serverTerminalId, runtimeDir, ...session }) => {
      void transcript; void threadId; void serverTerminalId; void runtimeDir;
      return { ...session, nativeAddress: !socket && !session.endedAt ? this.terminals.nativeAddress(session.terminalId) : undefined, conversation: session.tool === "codex" && !socket };
    });
  }
  async create(input: { project: string; tool: ToolName; title: string }): Promise<HerdrSession> {
    const project = realpathSync(input.project);
    if (!statSync(project).isDirectory()) throw new Error("请选择项目文件夹");
    if (!this.local.tools.some(tool => tool.name === input.tool && tool.status === "installed")) throw new Error("本机尚未安装这个 Agent");
    const id = randomUUID();
    const terminal = await this.terminals.start({ environmentId: this.local.id, tool: input.tool, missionId: `herdr:${id}`, runId: id, cwd: project });
    this.#records.unshift({ id, title: input.title.trim() || `${basename(project)} · ${input.tool}`, project, tool: input.tool, terminalId: terminal.id, createdAt: new Date().toISOString(), conversation: input.tool === "codex" });
    this.#save();
    return this.list()[0]!;
  }
  async conversation(id: string): Promise<HerdrConversation> {
    const record = this.#require(id);
    if (record.socket) throw new Error("这是旧接入方式的会话，原记录已保留；请新建原生终端会话");
    if (record.tool !== "codex") throw new Error("此 Agent 暂通过原生终端交互");
    const terminal = await this.terminals.inspect(record.terminalId);
    if (!record.transcript) {
      const found = await findCodexTranscript(terminal.pid, this.#home, terminal.labels["alma.session"]);
      if (found) { record.transcript = found.path; record.threadId = found.threadId; this.#save(); }
    }
    const messages = record.transcript && record.threadId ? await codexMessages(this.#home, record.transcript, record.threadId) : [];
    const state = terminal.status?.state;
    return { messages, approvals: [], running: state === "working" || state === "busy", notice: terminal.state === "finished" ? "终端已结束，历史记录仍保留。" : state === "needs_input" || state === "blocked" ? "Agent 正等待输入或授权，请切到终端处理。" : !record.transcript ? "正在等待原生会话记录。如果终端已有回复，对话记录关联尚未完成；可先在终端继续。" : undefined };
  }
  async image(id: string, messageId: string, offset: number): Promise<{ dataUrl: string }> {
    const record = this.#require(id);
    const message = (await this.conversation(id)).messages.find(message => message.id === messageId && message.role === "assistant");
    if (!message) throw new Error("找不到这条原生回复");
    return readHerdrImage(message.text, offset, record.project);
  }
  async send(id: string, text: string): Promise<void> {
    const record = this.#require(id);
    if (record.socket) throw new Error("旧会话只保留查看，请新建原生终端会话");
    await this.terminals.send(record.terminalId, text);
  }
  async interrupt(id: string): Promise<void> { await this.terminals.interrupt(this.#require(id).terminalId); }
  async end(id: string): Promise<void> {
    const record = this.#require(id);
    if (!this.terminals.get(record.terminalId)?.closedAt) await this.terminals.kill(record.terminalId);
    if (record.serverTerminalId && !this.terminals.get(record.serverTerminalId)?.closedAt) await this.terminals.kill(record.serverTerminalId);
    record.endedAt = new Date().toISOString(); this.#save();
  }
  #require(id: string): SessionRecord {
    const record = this.#records.find(session => session.id === id);
    if (!record) throw new Error("找不到这个 Herdr 会话");
    if (record.endedAt) throw new Error("会话已经结束");
    return record;
  }
  #save(): void {
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#records), { mode: 0o600 });
    renameSync(temp, this.#file);
  }
}
