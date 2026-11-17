import type { TerminalKind } from "../../packages/agent-protocol/terminal.ts";
import { ToolError } from "./errors.ts";
import type { TokenSigner } from "./scope.ts";

export const TERMINAL_ROLES = ["control", "observe"] as const;

export type TerminalRole = (typeof TERMINAL_ROLES)[number];

/** What the terminal layer needs to open a stream. It is a request, not a
 * stream: the tool layer never attaches, never types and never reads a frame. */
export interface TerminalTicketClaims {
  readonly v: 1;
  readonly kind: "terminal";
  readonly tokenId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly terminalKind: TerminalKind;
  readonly role: TerminalRole;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function mintTerminalTicket(
  signer: TokenSigner,
  claims: Omit<TerminalTicketClaims, "v" | "kind">,
): string {
  return signer.sign({ v: 1, kind: "terminal", ...claims });
}

export function verifyTerminalTicket(signer: TokenSigner, ticket: string): TerminalTicketClaims {
  const payload = signer.verify(ticket);
  if (payload.v !== 1 || payload.kind !== "terminal") {
    throw new ToolError("unauthenticated", "the ticket is not a terminal ticket");
  }
  const required = ["tokenId", "missionId", "runId", "terminalKind", "role", "issuedAt", "expiresAt"] as const;
  for (const field of required) {
    if (typeof payload[field] !== "string") throw new ToolError("unauthenticated", `the ticket has no ${field}`);
  }
  if (!(TERMINAL_ROLES as readonly string[]).includes(payload.role as string)) {
    throw new ToolError("unauthenticated", "the ticket names no terminal role");
  }
  if (!(["nativeTui", "pty", "exec"] as readonly string[]).includes(payload.terminalKind as string)) {
    throw new ToolError("unauthenticated", "the ticket names no terminal kind");
  }
  return payload as unknown as TerminalTicketClaims;
}
