// Which home commands a turn may send, and which need the person's own yes. A pure rule: no store, no adapter,
// no HTTP, so the one place a refusal is decided can be read in a minute and tested without a home.
import {
  homeActionIsSensitive,
  homeDomainAllows,
  type HomeAction,
  type HomeDomain,
  type HomeEntity,
} from "../../shared/home.ts";

/** What a bot is allowed to do with the home. Absent means `read`: the view still works, the bot only looks. */
export const HOME_ACCESS_LEVELS = ["off", "read", "control", "full"] as const;
export type HomeAccessLevel = (typeof HOME_ACCESS_LEVELS)[number];

export type HomeRefusalCode = "access_off" | "read_only" | "unsupported_action" | "unavailable" | "sensitive" | "zone_not_allowed";

export interface HomePolicy {
  access: HomeAccessLevel;
  /** Zones a bot may touch; null means every zone. A sensitive zone should be named here or left out. */
  zones?: readonly string[] | null;
  /** Domains a bot may touch; null means every domain. */
  domains?: readonly HomeDomain[] | null;
  /** Whether this turn may answer a sensitive action with the person's own yes. */
  canConfirmSensitive: boolean;
}

export type HomeVerdict =
  | { ok: true; needsConfirmation: boolean }
  | { ok: false; code: HomeRefusalCode; message: string };

const DENIED_SENSITIVE: ReadonlySet<HomeAction> = new Set(["unlock", "open"]);

/** The one decision. Read a state needs `read`; anything else needs `control`, and a sensitive action needs a yes. */
export function homeVerdict(policy: HomePolicy, entity: HomeEntity, action: HomeAction): HomeVerdict {
  if (policy.access === "off") return { ok: false, code: "access_off", message: "this bot's home access is off" };
  if (!entity.available) return { ok: false, code: "unavailable", message: `${entity.name} is not reachable right now` };
  if (!entity.actions.includes(action)) {
    return { ok: false, code: "unsupported_action", message: `${entity.name} does not accept ${action}; it accepts ${entity.actions.join(", ") || "no commands"}` };
  }
  if (!homeDomainAllows(entity.domain, action)) {
    return { ok: false, code: "unsupported_action", message: `a ${entity.domain} does not accept ${action}` };
  }
  if (policy.zones && entity.zone !== null && !policy.zones.includes(entity.zone)) {
    return { ok: false, code: "zone_not_allowed", message: `${entity.name} is in a zone this bot may not touch` };
  }
  if (policy.domains && !policy.domains.includes(entity.domain)) {
    return { ok: false, code: "zone_not_allowed", message: `this bot may not touch ${entity.domain} devices` };
  }
  if (policy.access === "read") return { ok: false, code: "read_only", message: "this bot may look at the home but not change it" };
  const sensitive = homeActionIsSensitive(entity.domain, action);
  if (sensitive) {
    // A `full` bot still cannot unlock a door on its own: that one answer is always the person's.
    if (!policy.canConfirmSensitive || policy.access !== "full") {
      return { ok: false, code: "sensitive", message: `${action} on ${entity.name} needs the person's own confirmation` };
    }
    return { ok: true, needsConfirmation: true };
  }
  return { ok: true, needsConfirmation: false };
}

/** Whether a domain is one a policy may even name, so a typo in a grant is refused rather than silently ignored. */
export function homePolicyAllowsDomain(policy: HomePolicy, domain: HomeDomain): boolean {
  return policy.domains === null || policy.domains === undefined || policy.domains.includes(domain);
}

export { DENIED_SENSITIVE };
