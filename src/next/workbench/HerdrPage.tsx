import { t } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { ChevronDown, ChevronLeft, Ellipsis, PanelLeft, PanelsTopLeft, Search, SquarePen, Terminal } from "lucide-react";
import { useStore } from "@/state/store";
import type { HerdrSession } from "../../../packages/agent-protocol/herdr";
import { apiClient } from "../foundation/api";
import { useEnvironments } from "../personal/foundation";
import { HerdrConversation } from "./HerdrConversation";
import { HerdrTerminal } from "./HerdrTerminal";
import { HerdrGrid } from "./HerdrGrid";
import "./herdr.css";

export function HerdrPage() {
  const { dispatch } = useStore();
  const [sidebar, setSidebar] = useState(true);
  const [machineMenuOpen, setMachineMenuOpen] = useState(false);
  const machineMenuRef = useRef<HTMLDetailsElement>(null);
  usePopoverDismiss(machineMenuOpen, machineMenuRef, () => setMachineMenuOpen(false));
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<HerdrSession[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("eac-herdr-session"));
  const [panes, setPanes] = useState<string[]>([]);
  const [creating, setCreating] = useState<false | "session" | "pane" | "workspace">(false);
  const createDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!creating) return;
    const dialog = createDialog.current!;
    dialog.showModal();
    return () => dialog.close();
  }, [creating]);
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [tool, setTool] = useState("codex");
  const [mode, setMode] = useState<"conversation" | "terminal">("conversation");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const environments = useEnvironments();
  const tools = environments.status === "ready" ? environments.data.find(value => value.kind === "local")?.tools?.filter(value => value.status === "installed") ?? [] : [];
  const active = sessions.find(session => session.id === selected) ?? null;
  const layoutKey = active && `eac-herdr-panes:${active.project}`;
  useEffect(() => {
    if (layoutKey && panes.length > 1) localStorage.setItem(layoutKey, JSON.stringify(panes));
  }, [layoutKey, panes]);
  const [expanded, setExpanded] = useState<string | null>(null);
  function projectPanes(projectPath: string, preview = false): string[] {
    const key = `eac-herdr-panes:${projectPath}`;
    let saved: unknown;
    try { saved = JSON.parse(localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? "[]"); } catch { saved = []; }
    const available = new Set(sessions.filter(s => s.project === projectPath && !s.endedAt).map(s => s.id));
    const restored: string[] = Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string" && available.has(id)))].slice(0, 4) : [];
    const first = selected && available.has(selected) ? selected : available.values().next().value;
    if (!first) return [];
    if (!preview && !restored.length) return [];
    const candidates = sessions.filter(s => available.has(s.id) && s.nativeAddress);
    const ordered = [...candidates.filter(s => s.id === first), ...candidates.filter(s => s.id !== first)];
    const tools = new Set<string>();
    const preferred = ordered.filter(s => {
      if (tools.has(s.tool)) return false;
      tools.add(s.tool);
      return true;
    });
    const defaults = [...new Set([...preferred, ...ordered].map(s => s.id))].slice(0, 4);
    const explicit = localStorage.getItem(key) !== null;
    return restored.length > 1 || (explicit && restored.length) ? restored : defaults.length ? defaults : [first];
  }
  function openGrid(projectPath: string) {
    const ids = projectPanes(projectPath, true);
    if (!ids.length) return;
    setExpanded(projectPath);
    localStorage.setItem(`eac-herdr-panes:${projectPath}`, JSON.stringify(ids));
    setSelected(selected && ids.includes(selected) ? selected : ids[0]);
    setPanes(ids);
    setCreating(false);
    setError("");
  }
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
  const existingWorkspace = creating === "workspace" && sessions.find(s => !s.endedAt && s.project === project.trim());
  const create = async () => {
    if (existingWorkspace) { openGrid(existingWorkspace.project); return; }
    setBusy(true); setError("");
    try {
      const result = await apiClient().request<{ session: HerdrSession }>("/herdr/sessions", { method: "POST", body: { project, title, tool } });
      await refresh();
      if (creating === "workspace") {
        const { id, project: path } = result.session;
        const prior = projectPanes(path);
        const ids = prior.length >= 4 ? prior : [...prior, id];
        localStorage.setItem(`eac-herdr-panes:${path}`, JSON.stringify(ids));
        setExpanded(path); setPanes(ids);
        setSelected(ids.includes(id) ? id : ids[0]);
        setCreating(false); setError(""); setMode("terminal"); setTitle("");
        return;
      }
      if (creating === "session") setPanes([]); else if (panes.length) setPanes(ids => result.session.project === active?.project && ids.length < 4 ? [...ids, result.session.id] : [result.session.id]); select(result.session); setMode("terminal"); setTitle("");
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
  const projects = [...new Set(sessions.filter(s => !s.endedAt).map(s => s.project))];
  const members = new Map(projects.map(path => [path, panes.length && active?.project === path ? panes : projectPanes(path)] as const));
  const groupedIds = new Set([...members.values()].flat());
  const ordinary = sessions.filter(s => !groupedIds.has(s.id));
  const groups = new Map<string, HerdrSession[]>();
  for (const session of ordinary.filter(item => `${item.title} ${item.project} ${item.tool}`.toLowerCase().includes(query.toLowerCase()))) groups.set(session.project, [...(groups.get(session.project) ?? []), session]);
  const projectName = active?.project.split(/[\\/]/).filter(Boolean).at(-1);
  const newSession = () => { setCreating("session"); setError(""); };
  return <div className="herdr-page" data-testid="herdr-page" data-sidebar={sidebar}>
    <aside className="herdr-sidebar" hidden={!sidebar}>
      <div className="herdr-sidebar-toolbar"><span>项目会话</span><button aria-label="收起会话栏" onClick={() => setSidebar(false)}><PanelLeft size={14} /></button><button aria-label="搜索会话" onClick={() => setSearching(value => !value)}><Search size={14} /></button></div>
      <header className="herdr-machine"><strong>这台电脑</strong><ChevronDown size={12} /><details ref={machineMenuRef} className="herdr-menu" open={machineMenuOpen}><summary aria-label="电脑菜单" onClick={event => { event.preventDefault(); setMachineMenuOpen(open => !open); }}><Ellipsis size={16} /></summary><div><button onClick={() => void refresh().catch(error => setError(error.message))}>刷新会话</button><button onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "resources" })}>资源与连接</button></div></details><button aria-label="新建会话" onClick={newSession}><SquarePen size={14} /></button></header>
      {searching && <input className="herdr-session-search" autoFocus aria-label="搜索会话" placeholder="搜索会话或项目" value={query} onChange={event => setQuery(event.target.value)} />}
      <div className="herdr-projects">
        <nav aria-label="分屏工作区" className="herdr-grid-nav">
          <div className="herdr-list-label">分屏工作区<button title="新建分屏工作区" aria-label="新建分屏工作区" onClick={() => {
            setProject(""); setTitle(""); setTool(tools[0]?.name ?? "codex"); setError(""); setCreating("workspace");
          }}><SquarePen size={14} /></button></div>
          {projects.map(path => <div key={path}>
            <div className="herdr-grid-nav-row"><button title={path} className="herdr-session"
              aria-current={panes.length && !creating && active?.project === path ? "page" : undefined} onClick={() => openGrid(path)}>
              <PanelsTopLeft size={15} /><span>{path.split(/[\\/]/).filter(Boolean).at(-1)}</span>
            </button><button aria-label={`展开或收起 ${path} 的面板`} aria-expanded={expanded === path} onClick={() => {
              if (expanded === path) setExpanded(null);
              else if (!members.get(path)?.length) openGrid(path);
              else setExpanded(path);
            }}><ChevronDown size={14} /></button></div>
            {expanded === path && <div className="herdr-grid-members">{members.get(path)?.map(id => {
              const session = sessions.find(s => s.id === id);
              return session && <button key={id} className="herdr-session" aria-current={!panes.length && !creating && selected === id ? "page" : undefined}
                onClick={() => { setPanes([]); select(session); setMode("terminal"); }}>
                <Terminal size={13} /><span>{session.title}</span><small>{session.nativeAddress}</small>
              </button>;
            })}</div>}
          </div>)}
          {!sessions.some(s => !s.endedAt) && <p className="herdr-sidebar-empty">点击「新建」选择项目文件夹。</p>}
        </nav>
        <div className="herdr-list-label">普通会话 <span>{ordinary.length}</span></div>{[...groups].map(([path, list]) => <section key={path}>
        <h3 title={path}>{path.split(/[\\/]/).filter(Boolean).at(-1)}</h3>
        {list.map(session => <button key={session.id} className="herdr-session" aria-current={!panes.length && !creating && active?.id === session.id ? "page" : undefined} onClick={() => { setPanes([]); select(session); }}>
          <span className="herdr-session-dot" data-ended={!!session.endedAt} /><span className="herdr-session-copy"><span>{session.title}</span><small>{session.tool}{session.endedAt ? " · 已结束" : ""}</small></span><time>{new Date(session.createdAt).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}</time>
        </button>)}
      </section>)}{sessions.length === 0 && <p className="herdr-sidebar-empty">新建会话后，项目会显示在这里。</p>}</div>
    </aside>
    <main className="herdr-main">
      <div className="herdr-topbar">{!sidebar && <button aria-label="展开会话栏" onClick={() => setSidebar(true)}><PanelLeft size={15} /></button>}<button aria-label="返回会话列表" onClick={() => { setCreating(false); setSelected(null); setPanes([]); }}><ChevronLeft size={15} /></button>{panes.length > 0 && !creating && <span>分屏工作区</span>}</div>
      {error && !creating && <div role="alert" className="herdr-error">{error}<button onClick={() => void refresh().then(() => setError(""), error => setError(error.message))}>重试</button></div>}
      {creating && <dialog ref={createDialog} className="herdr-create-dialog" aria-labelledby="herdr-create-title"
        onCancel={event => { event.preventDefault(); if (!busy) setCreating(false); }}>
        <form className="herdr-create" onSubmit={event => { event.preventDefault(); void create(); }}>
        <h2 id="herdr-create-title">{creating === "workspace" ? "新建分屏工作区" : "新建会话"}</h2><p>{creating === "workspace" ? "选择项目文件夹和首个 Agent，创建后可以继续添加面板。" : "选择项目文件夹与本机 Agent。会话会由 Herdr 保持，切换页面后仍可接回。"}</p>
        <label>项目文件夹<div className="herdr-folder"><input required value={project} placeholder="/path/to/project" onChange={event => setProject(event.target.value)} />{window.ogb?.pickFolder && <button type="button" onClick={() => void window.ogb!.pickFolder!(project).then(path => { if (path) setProject(path); })}>选择文件夹</button>}</div></label>
        {existingWorkspace ? <p>此文件夹已有分屏工作区，可直接打开。</p> : <><label>{t("composer.mention.agent")}<select value={tool} onChange={event => setTool(event.target.value)}>{!tools.some(item => item.name === tool) && <option value={tool} disabled>选择已安装的 Agent</option>}{tools.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>会话标题<input value={title} maxLength={200} placeholder="例如：修复登录问题" onChange={event => setTitle(event.target.value)} /></label>
        <p>{tool === "codex" ? "直接运行本机 Codex，沿用 CLI 的登录与配置。对话页读取原生记录，消息发送到同一终端；登录及授权在终端处理。" : "这个 Agent 当前通过原生终端交互。"}</p></>}
        {error && <div role="alert" className="herdr-error">{error}</div>}
        <footer><button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button>
        <button type="submit" disabled={busy || !project.trim() || (!existingWorkspace && !tools.some(item => item.name === tool))}>{busy ? "正在启动…" : existingWorkspace ? "打开工作区" : creating === "workspace" ? "创建分屏工作区" : "开始会话"}</button>
        </footer>
      </form></dialog>}
      {panes.length > 0 && active ? <HerdrGrid sessions={sessions} panes={panes} focused={active.id} onFocus={setSelected} onChange={ids => { if (layoutKey) { sessionStorage.removeItem(layoutKey); if (ids.length) localStorage.setItem(layoutKey, JSON.stringify(ids)); else localStorage.removeItem(layoutKey); } setPanes(ids); }} tools={tools.map(item => item.name)} onNew={chosenTool => { setProject(active.project); setTool(chosenTool); setTitle(""); setError(""); setCreating("pane"); }} /> : active ? <>
        <header className="herdr-session-header"><div className="herdr-breadcrumb"><span title={active.project}>{projectName}</span><span>/</span><details className="herdr-menu"><summary><strong>{active.title}</strong><ChevronDown size={12} /></summary><div><button disabled={busy || !!active.endedAt} onClick={() => void end()}>结束会话</button></div></details></div>
          <div className="herdr-views"><button aria-pressed={mode === "conversation"} disabled={!active.conversation} title={!active.conversation ? "此 Agent 暂仅支持原生终端" : undefined} onClick={() => setMode("conversation")}>对话</button><button aria-pressed={mode === "terminal"} onClick={() => void refresh().then(() => setMode("terminal"), error => setError(error.message))}>终端</button></div>
        </header>
        {active.endedAt ? <div className="herdr-empty">这个会话已结束。可以新建会话继续工作。</div> : mode === "conversation" && active.conversation
          ? <HerdrConversation key={active.id} session={active} draft={drafts[active.id] ?? ""} onDraftChange={text => setDrafts(previous => ({ ...previous, [active.id]: text }))} /> : <HerdrTerminal key={active.terminalId} terminalId={active.terminalId} onNew={() => { setProject(active.project); setTool(active.tool); setTitle(""); newSession(); }} />}
      </> : <div className="herdr-welcome"><Terminal size={36} /><h2>项目</h2><p>打开项目，让你的 Agent 开始工作。</p><button onClick={newSession}>新建会话</button></div>}
    </main>
  </div>;
}
