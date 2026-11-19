import { useEffect, useState } from "react";
import { useTerminalRegistry } from "./terminal-registry";
import type { ConnectionState } from "./terminal-transport";
import { TerminalSurface } from "./TerminalSurface";

export function HerdrTerminal({ terminalId, onNew, focused = true }: { terminalId: string; focused?: boolean; onNew(): void }) {
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
    <div className="herdr-terminal-screen">{(state.kind === "failed" || state.kind === "exited") && <div className="herdr-terminal-recovery"><p>{status}</p><p>旧记录会保留。</p><button onClick={onNew}>在此项目新建会话</button></div>}{binding && <TerminalSurface fontSize={fontSize} connection={binding.connection} canSend={control} focused={focused} label="Herdr 原生终端" onChip={() => {}} onTitle={() => {}} onFocusChange={() => {}} />}</div>
  </section>;
}
