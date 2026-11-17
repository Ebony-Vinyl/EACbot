export const ARTIFACT_KINDS = ["file", "diff", "log", "image", "report"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** A produced artifact is a reference plus metadata. Its content lives on the
 * user's computer; no secret ever becomes an artifact. */
export interface Artifact {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256?: string;
  readonly createdAt: string;
}

export const APPROVAL_STATUSES = ["pending", "allowed", "denied", "answered", "expired", "cancelled"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A pending decision an agent needs before acting. `interrupt` does not
 * answer it; the run stays waiting until a decision or an expiry arrives. */
export interface Approval {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  readonly status: ApprovalStatus;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly decidedBy?: string;
  readonly revision: number;
}
