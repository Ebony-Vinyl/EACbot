/** A deliberately small SemVer subset: exact versions, `*`, and the comparator/range forms used by plugin manifests. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemVer(value: string): SemVer | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1;
    if (aNumber) return -1;
    if (bNumber) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

interface Comparator {
  operator: ">=" | ">" | "<=" | "<" | "=";
  version: SemVer;
}

function upperBound(version: SemVer, kind: "caret" | "tilde"): Comparator {
  if (kind === "tilde") {
    return { operator: "<", version: { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] } };
  }
  if (version.major > 0) return { operator: "<", version: { major: version.major + 1, minor: 0, patch: 0, prerelease: [] } };
  if (version.minor > 0) return { operator: "<", version: { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] } };
  return { operator: "<", version: { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] } };
}

function expand(token: string): Comparator[] | null {
  const trimmed = token.trim();
  if (trimmed === "*" || trimmed === "") return [];
  if (trimmed.startsWith("^") || trimmed.startsWith("~")) {
    const version = parseSemVer(trimmed.slice(1));
    if (!version) return null;
    return [{ operator: ">=", version }, upperBound(version, trimmed.startsWith("^") ? "caret" : "tilde")];
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(trimmed);
  if (!match) return null;
  const version = parseSemVer(match[2]!);
  if (!version) return null;
  return [{ operator: (match[1] ?? "=") as Comparator["operator"], version }];
}

/** Supports `*`, exact versions, `^`, `~`, comparison tokens, space-separated AND, and `||` OR. */
export function validSemVerRange(range: string): boolean {
  const alternatives = range.split("||");
  if (!alternatives.length) return false;
  return alternatives.every((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => expand(token) !== null);
  });
}

export function satisfiesSemVer(versionText: string, range: string): boolean {
  const version = parseSemVer(versionText);
  if (!version) return false;
  return range.split("||").some((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    const comparators: Comparator[] = [];
    let prereleaseBase: SemVer | null = null;
    for (const token of tokens) {
      const expanded = expand(token);
      if (!expanded) return false;
      for (const comparator of expanded) {
        comparators.push(comparator);
        if (comparator.version.prerelease.length) prereleaseBase = comparator.version;
      }
    }
    if (version.prerelease.length && !prereleaseBase) return false;
    return comparators.every(({ operator, version: bound }) => {
      const comparison = compareSemVer(version, bound);
      if (operator === ">=") return comparison >= 0;
      if (operator === ">") return comparison > 0;
      if (operator === "<=") return comparison <= 0;
      if (operator === "<") return comparison < 0;
      return comparison === 0;
    });
  });
}
