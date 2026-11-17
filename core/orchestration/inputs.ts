import type { AgentKind, ModelRef } from "../../packages/agent-protocol/agents.ts";
import type { EnvironmentRef } from "../../packages/agent-protocol/environment.ts";
import type { MissionRuntime } from "../missions/runtime.ts";
import type { ToolArguments } from "./args.ts";
import { optionalObject } from "./args.ts";
import { ToolError } from "./errors.ts";
import type { SteerResultView } from "./types.ts";

/** The three answers a steer can have. The log is the only place the delivery is
 * recorded, so the answer is read back rather than assumed from the adapter's
 * return value: a steer the engine refused must not read as delivered. */
export function steerOutcomeOf(
  runtime: MissionRuntime,
  missionId: string,
  runId: string,
): { outcome: SteerResultView["outcome"]; reason?: string } {
  const entries = runtime.log.events(missionId, { limit: 200 });
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.runId !== runId) continue;
    if (entry.type === "run.steer_refused") {
      const reason = entry.payload.reason;
      return { outcome: "refused", ...(typeof reason === "string" ? { reason } : {}) };
    }
    if (entry.type === "run.steer_failed") {
      const message = entry.payload.message;
      return { outcome: "indeterminate", ...(typeof message === "string" ? { reason: message } : {}) };
    }
    if (entry.type === "run.steer_requested") return { outcome: "accepted" };
  }
  return { outcome: "indeterminate" };
}

const AUTH_MODES = ["subscription", "apiKey", "compatibleEndpoint", "local"] as const;

export function parseEnvironment(raw: Record<string, unknown>): EnvironmentRef {
  const kind = raw.kind;
  if (kind !== "ssh" && kind !== "local") throw new ToolError("invalid_arguments", "environment.kind must be ssh or local");
  const authMode = raw.authMode;
  if (typeof authMode !== "string" || !(AUTH_MODES as readonly string[]).includes(authMode)) {
    throw new ToolError("invalid_arguments", `environment.authMode must be one of ${AUTH_MODES.join(", ")}`);
  }
  const host = optionalEnvironmentText(raw, "host");
  const user = optionalEnvironmentText(raw, "user");
  const credentialRef = optionalEnvironmentText(raw, "credentialRef");
  const baseUrl = optionalEnvironmentText(raw, "baseUrl");
  const fingerprint = optionalEnvironmentText(raw, "hostKeyFingerprint");
  const port = raw.port;
  if (port !== undefined && (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new ToolError("invalid_arguments", "environment.port must be a valid port number");
  }
  return {
    id: environmentText(raw, "id"),
    label: environmentText(raw, "label"),
    kind,
    authMode: authMode as EnvironmentRef["authMode"],
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port: port as number } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(credentialRef !== undefined ? { credentialRef: credentialRef as EnvironmentRef["credentialRef"] } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(fingerprint !== undefined ? { hostKeyFingerprint: fingerprint } : {}),
  };
}

function environmentText(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_arguments", `environment.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalEnvironmentText(raw: Record<string, unknown>, key: string): string | undefined {
  if (raw[key] === undefined) return undefined;
  return environmentText(raw, key);
}

/** A model is only ever the one the caller named for this mission's agent. The
 * tool layer never substitutes a different model, so a typo is refused here
 * rather than silently running on something else. */
export function parseModel(args: ToolArguments, agent: AgentKind): ModelRef | undefined {
  const raw = optionalObject(args, "model");
  if (raw === undefined) return undefined;
  if (raw.agent !== agent) {
    throw new ToolError("invalid_arguments", "model.agent must match the mission's agent", { details: { agent } });
  }
  if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
    throw new ToolError("invalid_arguments", "model.model must be a non-empty string");
  }
  return {
    agent,
    model: raw.model.trim(),
    ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
    ...(typeof raw.variant === "string" ? { variant: raw.variant } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
  };
}
