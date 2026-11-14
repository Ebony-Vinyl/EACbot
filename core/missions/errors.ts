export class MissionNotFoundError extends Error {
  readonly missionId: string;

  constructor(missionId: string) {
    super(`no mission ${missionId}`);
    this.name = "MissionNotFoundError";
    this.missionId = missionId;
  }
}

export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`no run ${runId}`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

export class RevisionConflictError extends Error {
  readonly target: string;
  readonly expected: number;
  readonly actual: number;

  constructor(target: string, expected: number, actual: number) {
    super(`${target} is at revision ${actual}, caller saw ${expected}`);
    this.name = "RevisionConflictError";
    this.target = target;
    this.expected = expected;
    this.actual = actual;
  }
}
