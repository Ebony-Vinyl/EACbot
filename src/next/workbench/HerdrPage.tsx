import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, Ellipsis, PanelLeft, Search, SquarePen, Terminal } from "lucide-react";
import { useStore } from "@/state/store";
import type { HerdrSession } from "../../../packages/agent-protocol/herdr";
import { apiClient } from "../foundation/api";
import { useEnvironments } from "../personal/foundation";
import { HerdrConversation } from "./HerdrConversation";
import { useTerminalRegistry } from "./terminal-registry";
import type { ConnectionState } from "./terminal-transport";
import { TerminalSurface } from "./TerminalSurface";
import "./herdr.css";

export function HerdrPage() {
  const { dispatch } = useStore();
  const [sidebar, setSidebar] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<HerdrSession[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("eac-herdr-session"));
  const [creating, setCreating] = useState(false);
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [tool, setTool] = useState("codex");
  const [mode, setMode] = useState<"conversation" | "terminal">("conversation");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const environments = useEnvironments();
  const tools = environments.status === "ready" ? environments.data.find(value => value.kind === "local")?.tools?.filter(value => value.status === "installed") ?? [] : [];
  const active = sessions.find(session => session.id === selected) ?? null;
  const refresh = async () => {
    const result = await apiClient().request<{ sessions: HerdrSession[] }>("/herdr/sessions");
    setSessions(result.sessions);
  };
  useEffect(() => {
    let live = true;
    apiClient().request<{ sessions: HerdrSession[] }>("/herdr/sessions").then(result => { if (live) setSessions(result.sessions); }, error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, []);
  const select = (session: HerdrSession) => { setSelected(session.id); localStorage.setItem("eac-herdr-session", session.id); setMode(session.conversation ? "conversation" : "terminal"); setCreating(false); setError(""); };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const result = await apiClient().request<{ session: HerdrSession }>("/herdr/sessions", { method: "POST", body: { project, title, tool } });
      await refresh(); select(result.session); setMode("terminal"); setTitle("");
    } catch (error) { setError(error instanceof Error ? error.message : "会话未启动"); }
    finally { setBusy(false); }
  };
  const end = async () => {
    if (!active || !window.confirm("结束这个 Agent 会话？正在执行的工作会停止。")) return;
    setBusy(true);
    try { await apiClient().request(`/herdr/sessions/${encodeURIComponent(active.id)}/end`, { method: "POST", body: {} }); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "会话未结束"); }
    finally { setBusy(false); }
  };
  const groups = new Map<string, HerdrSession[]>();
  for (const session of sessions.filter(item => `${item.title} ${item.project} ${item.tool}`.toLowerCase().includes(query.toLowerCase()))) groups.set(session.project, [...(groups.get(session.project) ?? []), session]);
  const projectName = active?.project.split(/[\\/]/).filter(Boolean).at(-1);
  const newSession = () => { setCreating(true); setError(""); };
  return <div className="herdr-page" data-testid="herdr-page" data-sidebar={sidebar}>
    <aside className="herdr-sidebar" hidden={!sidebar}>
      <div className="herdr-sidebar-toolbar"><span>项目会话</span><button aria-label="收起会话栏" onClick={() => setSidebar(false)}><PanelLeft size={14} /></button><button aria-label="搜索会话" onClick={() => setSearching(value => !value)}><Search size={14} /></button></div>
      <header className="herdr-machine"><strong>这台电脑</strong><ChevronDown size={12} /><details className="herdr-menu"><summary aria-label="电脑菜单"><Ellipsis size={16} /></summary><div><button onClick={() => void refresh().catch(error => setError(error.message))}>刷新会话</button><button onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "resources" })}>资源与连接</button></div></details><button aria-label="新建会话" onClick={newSession}><SquarePen size={14} /></button></header>
      {searching && <input className="herdr-session-search" autoFocus aria-label="搜索会话" placeholder="搜索会话或项目" value={query} onChange={event => setQuery(event.target.value)} />}
      <div className="herdr-projects"><div className="herdr-list-label">会话 <span>{sessions.length}</span></div>{[...groups].map(([path, list]) => <section key={path}>
        <h3 title={path}>{path.split(/[\\/]/).filter(Boolean).at(-1)}</h3>
        {list.map(session => <button key={session.id} className="herdr-session" aria-current={!creating && active?.id === session.id ? "page" : undefined} onClick={() => select(session)}>
          <span className="herdr-session-dot" data-ended={!!session.endedAt} /><span className="herdr-session-copy"><span>{session.title}</span><small>{session.tool}{session.endedAt ? " · 已结束" : ""}</small></span><time>{new Date(session.createdAt).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}</time>
        </button>)}
      </section>)}{sessions.length === 0 && <p className="herdr-sidebar-empty">新建会话后，项目会显示在这里。</p>}</div>
    </aside>
    <main className="herdr-main">
      <div className="herdr-topbar">{!sidebar && <button aria-label="展开会话栏" onClick={() => setSidebar(true)}><PanelLeft size={15} /></button>}<button aria-label="返回会话列表" onClick={() => { setCreating(false); setSelected(null); }}><ChevronLeft size={15} /></button></div>
      {error && <div role="alert" className="herdr-error">{error}<button onClick={() => void refresh().then(() => setError(""), error => setError(error.message))}>重试</button></div>}
      {creating ? <form className="herdr-create" onSubmit={event => { event.preventDefault(); void create(); }}>
        <h2>在项目里开始工作</h2><p>选择项目文件夹与本机 Agent。会话会由 Herdr 保持，切换页面后仍可接回。</p>
        <label>项目文件夹<div className="herdr-folder"><input required value={project} placeholder="/path/to/project" onChange={event => setProject(event.target.value)} />{window.ogb?.pickFolder && <button type="button" onClick={() => void window.ogb!.pickFolder!(project).then(path => { if (path) setProject(path); })}>选择文件夹</button>}</div></label>
        <label>Agent<select value={tool} onChange={event => setTool(event.target.value)}>{!tools.some(item => item.name === tool) && <option value={tool} disabled>选择已安装的 Agent</option>}{tools.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>会话标题<input value={title} maxLength={200} placeholder="例如：修复登录问题" onChange={event => setTitle(event.target.value)} /></label>
        <p>{tool === "codex" ? "直接运行本机 Codex，沿用 CLI 的登录与配置。对话页读取原生记录，消息发送到同一终端；登录及授权在终端处理。" : "这个 Agent 当前通过原生终端交互。"}</p>
        <button type="submit" disabled={busy || !project.trim() || !tools.some(item => item.name === tool)}>{busy ? "正在启动…" : "开始会话"}</button>
      </form> : active ? <>
        <header className="herdr-session-header"><div className="herdr-breadcrumb"><span title={active.project}>{projectName}</span><span>/</span><details className="herdr-menu"><summary><strong>{active.title}</strong><ChevronDown size={12} /></summary><div><button disabled={busy || !!active.endedAt} onClick={() => void end()}>结束会话</button></div></details></div>
          <div className="herdr-views"><button aria-pressed={mode === "conversation"} disabled={!active.conversation} title={!active.conversation ? "此 Agent 暂仅支持原生终端" : undefined} onClick={() => setMode("conversation")}>对话</button><button aria-pressed={mode === "terminal"} onClick={() => void refresh().then(() => setMode("terminal"), error => setError(error.message))}>终端</button></div>
        </header>
        {active.endedAt ? <div className="herdr-empty">这个会话已结束。可以新建会话继续工作。</div> : mode === "conversation" && active.conversation
          ? <HerdrConversation key={active.id} session={active} draft={drafts[active.id] ?? ""} onDraftChange={text => setDrafts(previous => ({ ...previous, [active.id]: text }))} /> : <HerdrTerminal key={active.terminalId} terminalId={active.terminalId} onNew={() => { setProject(active.project); setTool(active.tool); setTitle(""); newSession(); }} />}
      </> : <div className="herdr-welcome"><Terminal size={36} /><h2>项目</h2><p>打开项目，让你的 Agent 开始工作。</p><button onClick={() => setCreating(true)}>新建会话</button></div>}
    </main>
  </div>;
}

function HerdrTerminal({ terminalId, onNew }: { terminalId: string; onNew(): void }) {
  const [fontSize, setFontSize] = useState(13);
  const registry = useTerminalRegistry({ wanted: [terminalId] });
  const binding = registry.bindings[terminalId];
  const control = binding?.lease.kind === "controlling";
  useEffect(() => { if (binding) registry.acquire(terminalId); }, [binding?.connection, registry.acquire, terminalId]);
  const [state, setState] = useState<ConnectionState>({ kind: "idle" });
  useEffect(() => {
    if (!binding) return;
    setState(binding.connection.state);
    return binding.connection.onEvent(event => { if (event.type === "state") setState(event.state); });
  }, [binding?.connection]);
  const status = state.kind === "live" ? (control ? "正在控制终端" : "观察模式")
    : state.kind === "failed" ? `连接失败：${state.message}`
    : state.kind === "exited" ? `终端已退出：${state.reason}${state.exitCode === undefined ? "" : ` (${state.exitCode})`}`
    : state.kind === "reconnecting" ? `正在重新连接：${state.detail}`
    : state.kind === "closed" ? "连接已关闭" : "正在连接终端…";
  return <section className="herdr-terminal">
    <header><div className="herdr-terminal-size"><button aria-label="缩小终端字号" disabled={fontSize <= 10} onClick={() => setFontSize(size => size - 1)}>−</button><span>{fontSize} pt</span><button aria-label="放大终端字号" disabled={fontSize >= 22} onClick={() => setFontSize(size => size + 1)}>+</button></div><span>{status}</span><button disabled={state.kind !== "live"} onClick={() => control ? registry.release(terminalId) : registry.acquire(terminalId)}>{control ? "释放控制" : "接管终端"}</button><button disabled={state.kind !== "failed" && state.kind !== "reconnecting"} onClick={() => registry.retry(terminalId)}>重新连接</button></header>
    <div className="herdr-terminal-screen">{(state.kind === "failed" || state.kind === "exited") && <div className="herdr-terminal-recovery"><p>{status}</p><p>旧记录会保留。</p><button onClick={onNew}>在此项目新建会话</button></div>}{binding && <TerminalSurface fontSize={fontSize} connection={binding.connection} canSend={control} focused label="Herdr 原生终端" onChip={() => {}} onTitle={() => {}} onFocusChange={() => {}} />}</div>
  </section>;
}
