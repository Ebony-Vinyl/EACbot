import { t } from "@/lib/i18n";
/** The mission panel: the tree of work under this mission, its history in
 * sequence order, and the commands a person can send.
 *
 * Every command carries the revision this panel last read, so a stale click
 * is refused by the authority rather than applied to a state nobody saw. The
 * history shows `seq` gaps and offers a resync instead of joining across them.
 */

import { useState } from "react";

import type { Mission } from "../../../packages/agent-protocol/mission.ts";
import type { MissionLogEntry as LogEntry } from "../../../packages/agent-protocol/events.ts";
import type { MissionNode } from "./mission-tree.ts";
import { eventDetail, eventLabel, type LogView } from "./event-log.ts";
import { isActive, isSettled, missionLabel, missionTone, needsInput } from "./status.ts";

export type MissionCommandKind = "steer" | "interrupt" | "resume" | "cancel";

export interface MissionPanelProps {
  readonly mission: Mission | null;
  readonly tree: readonly MissionNode<Mission>[];
  readonly history: LogView;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  readonly busy: MissionCommandKind | null;
  readonly commandError: string | null;
  readonly canMutate: boolean;
  readonly onSteer: (input: string) => void;
  readonly onInterrupt: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
  readonly onResync: () => void;
  readonly onSelect: (missionId: string) => void;
}

export function MissionPanel(props: MissionPanelProps) {
  const { mission } = props;
  if (!mission) {
    return (
      <section className="wb-inspector" aria-label={t("workspaceUi.copy12")}>
        <p className="wb-hint">{t("workspaceUi.copy43")}</p>
      </section>
    );
  }
  const active = isActive(mission);
  const settled = isSettled(mission);
  const canInterrupt = active && mission.status !== "interrupted";
  const canResume = mission.status === "interrupted" && !settled;

  return (
    <section className="wb-inspector" aria-label={`Mission ${mission.title}`}>
      <header className="wb-inspector-head">
        <h2 className="wb-inspector-title">{mission.title}</h2>
        <span className="wb-chip" data-tone={missionTone(mission.status)}>{missionLabel(mission.status)}</span>
        {needsInput(mission) ? <span className="wb-chip" data-tone="warning">{t("needsYou.title")}</span> : null}
      </header>

      <dl className="wb-facts">
        <div><dt>{t("composer.mention.agent")}</dt><dd>{mission.agent}</dd></div>
        <div><dt>{t("workspaceUi.copy13")}</dt><dd>{mission.revision}</dd></div>
        <div><dt>{t("settings.simple.page.computer")}</dt><dd>{mission.environment.label}</dd></div>
        {mission.model ? <div><dt>{t("usage.prices.colModel")}</dt><dd>{mission.model.label ?? mission.model.model}</dd></div> : null}
        {mission.error ? <div><dt>{t("workspaceUi.copy85")}</dt><dd className="wb-danger">{mission.error.message}</dd></div> : null}
      </dl>

      <MissionTree nodes={props.tree} currentId={mission.id} onSelect={props.onSelect} />

      <div className="wb-commands" role="group" aria-label={t("workspaceUi.copy14")}>
        {!props.canMutate ? (
          <p className="wb-hint">{t("workspaceUi.copy70")}</p>
        ) : (
          <SteerForm
            disabled={props.busy !== null || settled}
            busy={props.busy === "steer"}
            onSend={props.onSteer}
          />
        )}
        <div className="wb-command-row">
          <button
            type="button"
            className="wb-button"
            onClick={props.onInterrupt}
            disabled={!props.canMutate || props.busy !== null || !canInterrupt}
            title={canInterrupt ? t("workspaceUi.copy65") : t("workspaceUi.copy49")}
          >
            {props.busy === "interrupt" ? t("workspaceUi.interrupting") : t("call.turns.interrupt")}
          </button>
          <button
            type="button"
            className="wb-button"
            onClick={props.onResume}
            disabled={!props.canMutate || props.busy !== null || !canResume}
            title={canResume ? t("workspaceUi.copy57") : t("workspaceUi.copy50")}
          >
            {props.busy === "resume" ? t("workspaceUi.resuming") : t("workspaces.resume")}
          </button>
          <button
            type="button"
            className="wb-button wb-danger-button"
            onClick={props.onCancel}
            disabled={!props.canMutate || props.busy !== null || settled}
            title={settled ? t("workspaceUi.copy71") : t("workspaceUi.copy35")}
          >
            {props.busy === "cancel" ? t("engineSetup.device.cancelling") : t("task.bulk.cancel")}
          </button>
        </div>
        {props.commandError ? <p className="wb-error" role="alert">{props.commandError}</p> : null}
      </div>

      <HistoryStream
        view={props.history}
        loading={props.historyLoading}
        error={props.historyError}
        onResync={props.onResync}
      />
    </section>
  );
}

function SteerForm({ disabled, busy, onSend }: { disabled: boolean; busy: boolean; onSend: (input: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="wb-steer"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() === "") return;
        onSend(value);
        setValue("");
      }}
    >
      <label className="wb-field">
        <span>{t("workspaceUi.copy15")}</span>
        <textarea
          name="steer"
          rows={2}
          disabled={disabled}
          value={value}
          placeholder={t("workspaceUi.copy63")}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <button type="submit" className="wb-button" disabled={disabled || value.trim() === ""}>
        {busy ? t("pair.sending") : t("chat.send")}
      </button>
    </form>
  );
}

function MissionTree({ nodes, currentId, onSelect }: { nodes: readonly MissionNode<Mission>[]; currentId: string; onSelect: (missionId: string) => void }) {
  if (nodes.length === 0) return <p className="wb-hint">{t("workspaceUi.copy45")}</p>;
  return (
    <div className="wb-tree" role="tree" aria-label={t("workspaceUi.copy16")}>
      {nodes.map((node) => <TreeNode key={node.mission.id} node={node} currentId={currentId} onSelect={onSelect} />)}
    </div>
  );
}

function TreeNode({ node, currentId, onSelect }: { node: MissionNode<Mission>; currentId: string; onSelect: (missionId: string) => void }) {
  const current = node.mission.id === currentId;
  return (
    <div role="treeitem" aria-selected={current} aria-level={node.depth + 1} className="wb-tree-item" data-current={current ? "true" : "false"}>
      <button
        type="button"
        className="wb-tree-row"
        onClick={() => onSelect(node.mission.id)}
        style={{ paddingInlineStart: `${node.depth * 14}px` }}
      >
        <span className="wb-chip" data-tone={missionTone(node.mission.status)}>{missionLabel(node.mission.status)}</span>
        <span className="wb-tree-title">{node.mission.title}</span>
      </button>
      {node.children.map((child) => <TreeNode key={child.mission.id} node={child} currentId={currentId} onSelect={onSelect} />)}
    </div>
  );
}

function HistoryStream({ view, loading, error, onResync }: { view: LogView; loading: boolean; error: string | null; onResync: () => void }) {
  return (
    <section className="wb-history" aria-label={t("data.history")}>
      <header className="wb-history-head">
        <h3 className="wb-side-heading">{t("data.history")}</h3>
        <button type="button" className="wb-icon-button" onClick={onResync} title={t("workspaceUi.copy17")}>↻</button>
      </header>
      {error ? <p className="wb-error" role="alert">{error}</p> : null}
      {loading && view.entries.length === 0 ? (
        <div className="wb-side-loading" aria-busy="true" aria-label={t("workspaceUi.copy18")}>
          {[0, 1, 2].map((row) => <span key={row} className="wb-skeleton" />)}
        </div>
      ) : view.entries.length === 0 ? (
        <p className="wb-hint">{t("workspaceUi.copy48")}</p>
      ) : (
        <ol className="wb-log">
          {view.entries.map((entry, index) => (
            <li key={entry.seq} className="wb-log-row">
              <GapBetween previous={view.entries[index - 1]} entry={entry} onResync={onResync} />
              <LogRow entry={entry} />
            </li>
          ))}
        </ol>
      )}
      {view.gap ? (
        <p className="wb-gap" role="status">
          {t("workspaceUi.gapBetween", { count: view.gap.missing, after: view.gap.afterSeq, before: view.gap.beforeSeq })}
          <button type="button" className="wb-link-button" onClick={onResync}>{t("workspaceUi.copy19")}</button>
        </p>
      ) : null}
    </section>
  );
}

function GapBetween({ previous, entry, onResync }: { previous: LogEntry | undefined; entry: LogEntry; onResync: () => void }) {
  if (!previous || entry.seq <= previous.seq + 1) return null;
  return (
    <p className="wb-gap" role="status">
      {t("workspaceUi.gapAfter", { count: entry.seq - previous.seq - 1, after: previous.seq })}
      <button type="button" className="wb-link-button" onClick={onResync}>{t("webPanels.page.reload")}</button>
    </p>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const detail = eventDetail(entry);
  return (
    <div className="wb-log-entry" data-source={entry.source}>
      <span className="wb-log-seq">#{entry.seq}</span>
      <span className="wb-log-type">{eventLabel(entry.type)}</span>
      {detail ? <span className="wb-log-detail">{detail}</span> : null}
      <time className="wb-log-time" dateTime={entry.at}>{shortTime(entry.at)}</time>
    </div>
  );
}

function shortTime(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
