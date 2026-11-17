import { describe, expect, it } from "vitest";

import {
  exitChip,
  isActive,
  isSettled,
  missionGroup,
  missionLabel,
  missionTone,
  needsInput,
  needsInputMissions,
  sortMissions,
  terminalChip,
} from "./status.ts";

describe("terminal chips", () => {
  it("reads the words a program reports", () => {
    expect(terminalChip("working").state).toBe("working");
    expect(terminalChip("IDLE").state).toBe("idle");
    expect(terminalChip("needs_input").state).toBe("blocked");
    expect(terminalChip("finished").state).toBe("done");
  });

  it("answers unknown rather than guessing", () => {
    expect(terminalChip("compiling-kernel").state).toBe("unknown");
    expect(terminalChip(null).state).toBe("unknown");
    expect(terminalChip("  ").state).toBe("unknown");
  });

  it("names a clean exit as done and a failing one with its code", () => {
    expect(exitChip({ reason: "exited" }).state).toBe("done");
    expect(exitChip({ reason: "exited", exitCode: 0 }).state).toBe("done");
    expect(exitChip({ reason: "exited", exitCode: 3 })).toMatchObject({ state: "unknown", label: "Exited 3", tone: "warning" });
  });

  it("gives every state a tone from the palette's roles", () => {
    for (const word of ["idle", "working", "blocked", "done", "unknown"]) {
      expect(["neutral", "accent", "success", "warning", "danger"]).toContain(terminalChip(word).tone);
    }
  });
});

describe("mission states", () => {
  it("labels and tones every status the authority can report", () => {
    const statuses = ["queued", "provisioning", "running", "waiting_input", "waiting_children", "interrupted", "resuming", "succeeded", "failed", "cancelled"] as const;
    for (const status of statuses) {
      expect(missionLabel(status)).not.toBe("");
      expect(missionTone(status)).not.toBeUndefined();
    }
    expect(missionLabel("waiting_input")).toBe("Needs input");
    expect(missionTone("failed")).toBe("danger");
  });

  it("counts only a mission waiting for a person as needing input", () => {
    expect(needsInput({ status: "waiting_input" })).toBe(true);
    expect(needsInput({ status: "running" })).toBe(false);
  });

  it("separates live work from settled work", () => {
    expect(isActive({ status: "running" })).toBe(true);
    expect(isActive({ status: "waiting_children" })).toBe(true);
    expect(isActive({ status: "interrupted" })).toBe(false);
    expect(isSettled({ status: "succeeded" })).toBe(true);
    expect(isSettled({ status: "running" })).toBe(false);
  });
});

describe("mission order", () => {
  const mission = (id: string, status: "waiting_input" | "running" | "interrupted" | "succeeded", updatedAt: string) =>
    ({ id, status, updatedAt });

  it("puts needs-input first, then live, paused and settled", () => {
    const ordered = sortMissions([
      mission("settled", "succeeded", "2026-01-01T00:00:04.000Z"),
      mission("live", "running", "2026-01-01T00:00:03.000Z"),
      mission("input", "waiting_input", "2026-01-01T00:00:02.000Z"),
      mission("paused", "interrupted", "2026-01-01T00:00:01.000Z"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["input", "live", "paused", "settled"]);
  });

  it("breaks a group tie on the newest update", () => {
    const ordered = sortMissions([
      mission("old", "running", "2026-01-01T00:00:01.000Z"),
      mission("new", "running", "2026-01-01T00:00:09.000Z"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("is stable when two missions share a time", () => {
    const same = "2026-01-01T00:00:00.000Z";
    const ordered = sortMissions([mission("b", "running", same), mission("a", "running", same)]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input", () => {
    const input = [mission("b", "succeeded", "2026-01-01T00:00:00.000Z"), mission("a", "waiting_input", "2026-01-01T00:00:00.000Z")];
    sortMissions(input);
    expect(input.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("groups a mission once", () => {
    expect(missionGroup({ status: "waiting_input" })).toBe("needs_input");
    expect(missionGroup({ status: "resuming" })).toBe("active");
    expect(missionGroup({ status: "interrupted" })).toBe("paused");
    expect(missionGroup({ status: "cancelled" })).toBe("settled");
  });

  it("filters the pinned strip", () => {
    expect(needsInputMissions([{ status: "running" }, { status: "waiting_input" }])).toHaveLength(1);
  });
});


it("translates status labels after the language is loaded without changing wire states", async () => {
  const { loadLocale, setLocale } = await import("@/lib/i18n");
  try {
    await loadLocale("zh");
    expect(missionLabel("running")).toBe("运行中");
    expect(terminalChip("working").state).toBe("working");
    expect(terminalChip("working").label).toMatch(/[\u3400-\u9fff]/);
    expect(exitChip({ reason: "exit", exitCode: 0 }).label).toBe("已退出");
  } finally {
    setLocale("en");
  }
});
