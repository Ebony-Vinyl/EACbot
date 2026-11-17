/**
 * Every mission command this feature sends, in one place.
 *
 * Each call names a command id and the revision the person was looking at.
 * Foundation builds the command and posts it; nothing here derives a revision
 * from a response, because a response's revision describes a state the screen
 * has not read yet. After an action the screen refetches, and a live
 * notification tells it when to.
 */
import {
  cancelMission, createMission, interruptMission, newCommandId, resolveApproval, resumeMission, steerMission,
  submitMissionInput,
} from "../foundation/api.ts";
import type { CommandResult } from "../../../packages/agent-protocol/commands.ts";
import type { ApprovalInput, CancelOptions, CreateMissionInput, MissionActions, MissionCommandInput, ReconcileInput } from "./port.ts";

/** A command id for one attempt. A retry of the same intent reuses the id the
 * caller already made, so the authority replays instead of acting twice. */
export const commandId = newCommandId;

export const missionActions: MissionActions = {
  create: (input: CreateMissionInput): Promise<CommandResult> =>
    createMission(
      {
        title: input.title,
        prompt: input.prompt,
        agent: input.agent as Parameters<typeof createMission>[0]["agent"],
        environment: input.environment,
        ...(input.model !== undefined ? { model: input.model as Parameters<typeof createMission>[0]["model"] } : {}),
        ...(input.parentMissionId !== undefined ? { parentMissionId: input.parentMissionId } : {}),
      },
      { commandId: input.commandId },
    ),

  steer: (missionId: string, input: string, command: MissionCommandInput): Promise<CommandResult> =>
    steerMission(missionId, command.expectedRevision, input, { commandId: command.commandId }),

  interrupt: (missionId: string, command: MissionCommandInput, reason?: string): Promise<CommandResult> =>
    interruptMission(missionId, command.expectedRevision, {
      commandId: command.commandId,
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    }),

  resume: (missionId: string, command: MissionCommandInput): Promise<CommandResult> =>
    resumeMission(missionId, command.expectedRevision, { commandId: command.commandId }),

  cancel: (missionId: string, command: MissionCommandInput, options: CancelOptions = {}): Promise<CommandResult> =>
    cancelMission(missionId, command.expectedRevision, {
      commandId: command.commandId,
      ...(options.cascade !== undefined ? { cascade: options.cascade } : {}),
      ...(options.reason !== undefined && options.reason.length > 0 ? { reason: options.reason } : {}),
    }),

  submitInput: (missionId: string, input: string, command: MissionCommandInput): Promise<CommandResult> =>
    submitMissionInput(missionId, command.expectedRevision, input, { commandId: command.commandId }),

  resolve: (input: ApprovalInput): Promise<CommandResult> =>
    resolveApproval(input.missionId, input.approvalId, input.expectedRevision, input.decision, {
      commandId: input.commandId,
      ...(input.decision === "answer" && input.answer !== undefined ? { answer: input.answer } : {}),
    }),

  reconcile: (missionId: string, input: ReconcileInput): Promise<CommandResult> =>
    reconcileViaApi(missionId, input),
};

/** `run.reconcile` has no dedicated helper in foundation yet, so this posts
 * the same command the route accepts through the shared client. */
function reconcileViaApi(missionId: string, input: ReconcileInput): Promise<CommandResult> {
  return import("../foundation/http.ts").then(({ apiClient }) =>
    apiClient().request<CommandResult>(`/missions/${encodeURIComponent(missionId)}/reconcile`, {
      method: "POST",
      body: {
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        action: input.action,
        ...(input.reason !== undefined && input.reason.length > 0 ? { reason: input.reason } : {}),
      },
    }),
  );
}

/** The revision an action was decided against. Kept explicit so a screen that
 * renders a stale snapshot cannot accidentally send a fresher number. */
export function revisionOf(mission: { readonly revision: number }): number {
  return mission.revision;
}
