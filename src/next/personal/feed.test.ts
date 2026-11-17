import { describe, expect, it } from "vitest";

import type { MissionLogEntry } from "../../../packages/agent-protocol/events.ts";
import { buildFeed, formatBytes, openQuestion, pendingApprovals } from "./feed.ts";

let seq = 0;
function entry(type: string, payload: Record<string, unknown>, extra: Partial<MissionLogEntry> = {}): MissionLogEntry {
  seq += 1;
  return {
    seq,
    eventId: `e-${seq}`,
    missionId: "m-1",
    runId: "r-1",
    at: `2026-11-15T10:00:${String(seq).padStart(2, "0")}Z`,
    source: "adapter",
    type,
    payload,
    ...extra,
  };
}

describe("the conversation a mission log describes", () => {
  it("shows the prompt first, then what the run produced", () => {
    const items = buildFeed([entry("run.output", { text: "Working on it.", stream: "assistant" })], {
      prompt: "Summarise the inbox",
      promptAt: "2026-11-15T09:59:00Z",
    });
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "Summarise the inbox" });
  });

  it("folds consecutive assistant chunks of one run into one message", () => {
    const items = buildFeed([
      entry("run.output", { text: "Hello", stream: "assistant" }),
      entry("run.output", { text: ", world", stream: "assistant" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello, world" });
  });

  it("starts a new message when the run changes", () => {
    const items = buildFeed([
      entry("run.output", { text: "first", stream: "assistant" }),
      entry("run.output", { text: "second", stream: "assistant" }, { runId: "r-2" }),
    ]);
    expect(items).toHaveLength(2);
  });

  it("keeps stdout and stderr out of the assistant's prose", () => {
    const items = buildFeed([
      entry("run.output", { text: "hello", stream: "assistant" }),
      entry("run.output", { text: "npm warn", stream: "stderr" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["assistant", "output"]);
    expect(items[1]).toMatchObject({ stream: "stderr", text: "npm warn" });
  });

  it("marks the newest assistant message streaming only while the run is live", () => {
    const entries = [entry("run.output", { text: "typing", stream: "assistant" })];
    expect(buildFeed(entries, { live: true })[0]).toMatchObject({ streaming: true });
    expect(buildFeed(entries, { live: false })[0]).toMatchObject({ streaming: false });
  });

  it("pairs a tool call with its result, and marks a failed result", () => {
    const items = buildFeed([
      entry("run.tool_call", { callId: "c1", tool: "bash", input: { command: "ls" } }),
      entry("run.tool_result", { callId: "c1", tool: "bash", ok: true, output: "a.txt" }),
      entry("run.tool_call", { callId: "c2", tool: "bash", input: { command: "false" } }),
      entry("run.tool_result", { callId: "c2", tool: "bash", ok: false, output: "exit 1" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "tool", callId: "c1", status: "ok", output: "a.txt" });
    expect(items[1]).toMatchObject({ kind: "tool", callId: "c2", status: "failed" });
  });

  it("records a tool result whose call never arrived instead of dropping it", () => {
    const items = buildFeed([entry("run.tool_result", { callId: "ghost", tool: "bash", ok: true, output: "x" })]);
    expect(items[0]).toMatchObject({ kind: "tool", callId: "ghost", status: "ok" });
  });

  it("moves an approval from pending to decided exactly once", () => {
    const items = buildFeed([
      entry("run.approval_requested", { approvalId: "a1", action: "write file", detail: "/etc/hosts" }),
      entry("run.approval_resolved", { approvalId: "a1", decision: "allow" }),
      entry("run.approval_resolved", { approvalId: "a1", decision: "deny" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "approval", status: "allowed" });
  });

  it("reads an authority approval decision as the same approval", () => {
    const items = buildFeed([
      entry("run.approval_requested", { approvalId: "a1", action: "deploy", detail: "prod" }),
      entry("approval.resolved", { approvalId: "a1", decision: "answer", answer: "use staging" }, { source: "authority", runId: undefined }),
    ]);
    expect(items[0]).toMatchObject({ status: "answered", answer: "use staging" });
  });

  it("answers the open question with the input the run received", () => {
    const items = buildFeed([
      entry("run.waiting_input", { question: "Which branch?" }),
      entry("run.input_received", { input: "main" }),
    ]);
    expect(items[0]).toMatchObject({ kind: "question", question: "Which branch?", answer: "main" });
    expect(openQuestion(items)).toBeUndefined();
  });

  it("shows a steer as the person's own message", () => {
    const items = buildFeed([entry("run.steer_requested", { input: "also check the tests" }, { source: "authority" })]);
    expect(items[0]).toMatchObject({ kind: "user", text: "also check the tests" });
  });

  it("lists only approvals that still wait for someone", () => {
    const items = buildFeed([
      entry("run.approval_requested", { approvalId: "a1", action: "x", detail: "" }),
      entry("run.approval_requested", { approvalId: "a2", action: "y", detail: "" }),
      entry("run.approval_resolved", { approvalId: "a1", decision: "deny" }),
    ]);
    expect(pendingApprovals(items).map((item) => item.approvalId)).toEqual(["a2"]);
  });

  it("settles a child's row in place rather than adding a second one", () => {
    const items = buildFeed([
      entry("run.child_spawned", { childMissionId: "c-1" }),
      entry("run.child_settled", { childMissionId: "c-1", status: "failed" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "child", childMissionId: "c-1", status: "failed" });
  });

  it("reports an artifact with its size", () => {
    const items = buildFeed([entry("run.artifact", { artifactId: "f1", path: "out/report.md", bytes: 2048, mediaType: "text/markdown" })]);
    expect(items[0]).toMatchObject({ kind: "artifact", path: "out/report.md", bytes: 2048 });
    expect(formatBytes(2048)).toBe("2.0 kB");
  });

  it("turns a failure into a notice carrying the engine's own message", () => {
    const items = buildFeed([entry("run.failed", { code: "rate_limited", message: "Too many requests" })]);
    expect(items[0]).toMatchObject({ kind: "notice", tone: "error", text: "Too many requests" });
  });

  it("says an interrupted run is resumable, and says when it is not", () => {
    const resumable = buildFeed([entry("run.interrupted", { resumable: true })]);
    const terminal = buildFeed([entry("run.interrupted", { resumable: false })]);
    expect((resumable[0] as { text: string }).text).toContain("can be resumed");
    expect((terminal[0] as { text: string }).text).toContain("cannot be resumed");
  });

  it("ignores a type it has no row for instead of inventing one", () => {
    expect(buildFeed([entry("run.something_new", { text: "x" })])).toEqual([]);
  });

  it("ignores an output event with no text", () => {
    expect(buildFeed([entry("run.output", { stream: "assistant" })])).toEqual([]);
  });
});
