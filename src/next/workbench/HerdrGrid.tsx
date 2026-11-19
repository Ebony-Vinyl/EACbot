import { useState } from "react";
import type { HerdrSession } from "../../../packages/agent-protocol/herdr";
import { apiClient } from "../foundation/api";
import { HerdrTerminal } from "./HerdrTerminal";

interface Props {
  sessions: HerdrSession[];
  panes: string[];
  focused: string;
  onFocus(id: string): void;
  onChange(ids: string[]): void;
  tools: string[];
  onNew(tool: string): void;
}

export function HerdrGrid({ sessions, panes, focused, onFocus, onChange, tools, onNew }: Props) {
  const [notice, setNotice] = useState("");
  const visible = panes.flatMap(id => sessions.filter(session => session.id === id));
  const [message, setMessage] = useState("");
  const [peerId, setPeerId] = useState("");
  const [sending, setSending] = useState(false);
  const peers = visible.filter(s => s.id !== focused && s.nativeAddress && !s.endedAt);
  const peer = peers.find(s => s.id === peerId) ?? peers[0];
  async function delegate() {
    if (!peer || !message.trim() || sending) return;
    const sender = visible.find(s => s.id === focused);
    if (!sender?.nativeAddress) return;
    setSending(true);
    try {
      const text = `请通过 hc send 将下面的任务交给终端 ${peer.nativeAddress}，请对方将结果回复到你的终端 ${sender.nativeAddress}。任务内容：\n${message.trim()}`;
      await apiClient().request(`/herdr/sessions/${encodeURIComponent(sender.id)}/messages`, { method: "POST", body: { text } });
      setMessage(""); setNotice(`已向 ${sender.title} 提交委派请求`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "委派请求发送失败"); }
    finally { setSending(false); }
  }
  const project = visible[0]?.project;
  const available = sessions.filter(s => s.project === project && !s.endedAt && !panes.includes(s.id));
  function close(id: string) {
    const remaining = panes.filter(pane => pane !== id);
    if (focused === id && remaining.length) onFocus(remaining[0]);
    onChange(remaining);
  }
  return <section className="herdr-workspace">
    <header className="herdr-grid-tools"><strong>{project?.split(/[\\/]/).pop()}</strong>
      <select aria-label="添加已有会话" value="" disabled={!available.length || panes.length >= 4} onChange={event => {
        const id = event.target.value;
        onChange([...panes, id]); onFocus(id);
      }}><option value="">添加已有会话</option>{available.map(s => <option key={s.id} value={s.id}>{s.tool} · {s.title}</option>)}</select>
      <select aria-label="添加 Agent" value="" disabled={panes.length >= 4 || !tools.length} onChange={event => onNew(event.target.value)}>
        <option value="">添加 Agent…</option>{tools.map(tool => <option key={tool} value={tool}>{tool}</option>)}
      </select>
    </header>
    <div className="herdr-grid" data-count={visible.length}>{visible.map(session => <section key={session.id} className="herdr-grid-pane" data-active={session.id === focused}
      onPointerDown={() => onFocus(session.id)} onFocusCapture={() => onFocus(session.id)}>
      <header><strong title={session.title}>{session.title}</strong><span>{session.tool}</span>
        {session.nativeAddress && <button title="复制命令，供其他 Agent 给此终端发送消息" onClick={async () => {
          try { await navigator.clipboard.writeText(`hc send ${session.nativeAddress} "消息内容"`); setNotice(`已复制发往 ${session.nativeAddress} 的命令`); }
          catch { setNotice(`hc send ${session.nativeAddress} "消息内容"`); }
        }}>{session.nativeAddress}</button>}
        <button aria-label={`移除面板：${session.title}`} onClick={() => close(session.id)}>×</button>
      </header>
      <HerdrTerminal terminalId={session.terminalId} focused={session.id === focused} onNew={() => onNew(session.tool)} />
    </section>)}</div>
    {peers.length > 0 && visible.find(s => s.id === focused)?.nativeAddress && <form className="herdr-delegate" onSubmit={event => { event.preventDefault(); void delegate(); }}>
      <span>{visible.find(s => s.id === focused)?.title} →</span>
      <select aria-label="协作目标" value={peer?.id} onChange={event => setPeerId(event.target.value)}>{peers.map(s => <option key={s.id} value={s.id}>{s.tool} · {s.title}</option>)}</select>
      <input aria-label="协作任务" placeholder="交给另一位 Agent 的任务" disabled={sending} value={message} onChange={event => setMessage(event.target.value)} />
      <button disabled={sending || !message.trim()}>请求协作</button>
    </form>}
    {notice && <output>{notice}</output>}
  </section>;
}
