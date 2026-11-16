import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Command, Copy, Square } from "lucide-react";
import { CodexToolIcon } from "./CodexToolIcon";
import { toolLabel, TOOL_GROUP_LABELS } from "./herdr-tool-presentation";
import { HerdrMessageMarkdown } from "./HerdrMessageMarkdown";
import type { HerdrConversation as Conversation, HerdrSession } from "../../../packages/agent-protocol/herdr";
import { apiClient } from "../foundation/api";

export function HerdrConversation({ session, draft: text, onDraftChange: setText }: { session: HerdrSession; draft: string; onDraftChange(text: string): void }) {
  const [data, setData] = useState<Conversation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  const base = `/herdr/sessions/${encodeURIComponent(session.id)}`;
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await apiClient().request<Conversation>(`${base}/conversation`);
        if (!disposed) { setData(next); setError(""); }
      } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : "无法读取会话"); }
      if (!disposed) timer = setTimeout(() => void refresh(), 1000);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [base]);
  useEffect(() => {
    const node = history.current;
    if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 180) node.scrollTop = node.scrollHeight;
  }, [data]);
  const action = async (path: string, body = {}) => {
    setBusy(true); setError("");
    try { await apiClient().request(`${base}/${path}`, { method: "POST", body }); return true; }
    catch (error) { setError(error instanceof Error ? error.message : "操作失败"); return false; }
    finally { setBusy(false); }
  };
  const groups: { role: string; messages: NonNullable<Conversation["messages"]> }[] = [];
  for (const message of data?.messages ?? []) {
    const previous = groups.at(-1);
    if (message.role === "tool" && previous?.role === "tool") previous.messages.push(message);
    else groups.push({ role: message.role, messages: [message] });
  }
  return <section className="herdr-conversation" aria-label="会话对话">
    <div className="herdr-history" ref={history} aria-live="polite">
      {data?.messages.length === 0 && <p className="herdr-empty">在这个项目里开始一项工作。对话和终端使用同一个 Codex 会话。</p>}
      {!data && !error && <p role="status">正在读取会话…</p>}
      {groups.map(group => group.role === "tool"
        ? <details className="herdr-tool-group" key={group.messages[0]!.id}><summary><CodexToolIcon kind={group.messages.every(message => toolLabel(message).kind === toolLabel(group.messages[0]!).kind) ? toolLabel(group.messages[0]!).kind : "command"} /><span>{group.messages.every(message => toolLabel(message).kind === toolLabel(group.messages[0]!).kind) ? TOOL_GROUP_LABELS[toolLabel(group.messages[0]!).kind] : "工具操作"} · {group.messages.length} 步</span><ChevronDown size={12} /></summary><div className="herdr-tool-timeline">{group.messages.map(message => {
          const { kind, label } = toolLabel(message);
          return <details className="herdr-tool" key={message.id}><summary title={label}><CodexToolIcon kind={kind} /><span>{label}</span><ChevronDown size={12} /></summary><div className="herdr-tool-detail">{message.tool ? <>{message.tool.input && <><strong>输入</strong><pre>{message.tool.input}</pre></>}{message.tool.output !== undefined && <><strong>结果</strong><pre>{message.tool.output || "无输出"}</pre></>}</> : <pre>{message.text}</pre>}</div></details>;
        })}</div></details>
        : group.messages.map(message => <article className="herdr-message" data-role={message.role} key={message.id}>
          {message.role === "assistant" ? <HerdrMessageMarkdown text={message.text} sessionId={session.id} messageId={message.id} /> : <div>{message.text}</div>}
          {message.role === "assistant" && <button className="herdr-copy" aria-label="复制回复" onClick={() => void navigator.clipboard.writeText(message.text).catch(() => setError("复制失败，请重试"))}><Copy size={13} /></button>}
        </article>))}
      {data?.notice && <p role="status">{data.notice}</p>}
      {data?.running && <p role="status">正在工作…</p>}
      {data?.error && <p className="herdr-error">{data.error}</p>}
    </div>
    {error && <p role="alert" className="herdr-error">{error}</p>}
    <form className="herdr-composer" onSubmit={event => { event.preventDefault(); if (text.trim() && !busy && !data?.running) void action("messages", { text }).then(sent => { if (sent) setText(""); }); }}>
      <textarea aria-label="给 Agent 发消息" placeholder="给 Codex 发消息" rows={2} value={text} maxLength={32000} onChange={event => setText(event.target.value)} disabled={busy}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <footer><details className="herdr-composer-help"><summary aria-label="输入快捷键"><Command size={15} /></summary><span>Enter 发送 · Shift + Enter 换行</span></details><span className="herdr-composer-state">{data?.running ? "工作中" : "Codex"}</span>{data?.running
        ? <button type="button" aria-label="停止本轮" disabled={busy} onClick={() => void action("interrupt")}><Square size={12} fill="currentColor" /></button>
        : <button type="submit" aria-label={busy ? "发送中" : "发送"} disabled={busy || !text.trim() || !data || !!error}><ArrowUp size={16} /></button>}</footer>
    </form>
  </section>;
}
