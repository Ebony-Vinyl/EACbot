/** What a paired client may do. `readonly` reads only; `device` also mutates
 * missions, approvals and terminal tickets; `owner` additionally changes the
 * user's environments and revokes other sessions.
 *
 * The HTTP layer names a required scope per route, so a new route cannot be
 * added without deciding which scope it needs. */
export const PERMISSION_SCOPES = ["readonly", "device", "owner"] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

const RANK: Readonly<Record<PermissionScope, number>> = {
  readonly: 1,
  device: 2,
  owner: 3,
};

export function isPermissionScope(value: unknown): value is PermissionScope {
  return typeof value === "string" && (PERMISSION_SCOPES as readonly string[]).includes(value);
}

export function scopeSatisfies(granted: PermissionScope, required: PermissionScope): boolean {
  return RANK[granted] >= RANK[required];
}
