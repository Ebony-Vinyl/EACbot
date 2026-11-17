/**
 * Every failure this layer can report is one of these classes, so a caller
 * branches on a type instead of matching a message. Each carries the data a
 * screen needs to say what happened and what the person may do next.
 */

export type EnvironmentErrorKind =
  | "invalidRecord"
  | "secretInRecord"
  | "duplicateEnvironment"
  | "unknownEnvironment"
  | "revisionConflict"
  | "storeCorrupt"
  | "storeBusy"
  | "unsafeSshArguments"
  | "sshFailed"
  | "sshDisconnected"
  | "hostKeyMissing"
  | "hostKeyChanged"
  | "hostKeyConfirmationRequired"
  | "fingerprintMismatch"
  | "notNonRoot"
  | "diskLow"
  | "versionMismatch"
  | "installChecksum"
  | "installFailed"
  | "installRolledBack"
  | "confirmationRequired"
  | "toolProbeFailed";

export class EnvironmentError extends Error {
  readonly kind: EnvironmentErrorKind;

  constructor(kind: EnvironmentErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnvironmentError";
    this.kind = kind;
  }
}

export class InvalidEnvironmentError extends EnvironmentError {
  constructor(message: string) {
    super("invalidRecord", message);
    this.name = "InvalidEnvironmentError";
  }
}

/** A record carried a field name that holds a secret. The value is never echoed. */
export class SecretInEnvironmentError extends EnvironmentError {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super("secretInRecord", `an environment record may not carry secret fields: ${fields.join(", ")}`);
    this.name = "SecretInEnvironmentError";
    this.fields = fields;
  }
}

export class DuplicateEnvironmentError extends EnvironmentError {
  readonly id: string;

  constructor(id: string) {
    super("duplicateEnvironment", `environment ${id} already exists`);
    this.name = "DuplicateEnvironmentError";
    this.id = id;
  }
}

export class UnknownEnvironmentError extends EnvironmentError {
  readonly id: string;

  constructor(id: string) {
    super("unknownEnvironment", `no environment ${id}`);
    this.name = "UnknownEnvironmentError";
    this.id = id;
  }
}

export class EnvironmentRevisionConflictError extends EnvironmentError {
  readonly id: string;
  readonly expected: number;
  readonly actual: number;

  constructor(id: string, expected: number, actual: number) {
    super("revisionConflict", `environment ${id} is at revision ${actual}, caller saw ${expected}`);
    this.name = "EnvironmentRevisionConflictError";
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

export class EnvironmentStoreCorruptError extends EnvironmentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("storeCorrupt", message, options);
    this.name = "EnvironmentStoreCorruptError";
  }
}

/** Another writer held the store's lock past the timeout. */
export class EnvironmentStoreBusyError extends EnvironmentError {
  constructor(message: string) {
    super("storeBusy", message);
    this.name = "EnvironmentStoreBusyError";
  }
}

/** An ssh argv would let ssh run a command or stop verifying the host key. */
export class UnsafeSshArgumentsError extends EnvironmentError {
  constructor(message: string) {
    super("unsafeSshArguments", message);
    this.name = "UnsafeSshArgumentsError";
  }
}

export class SshFailureError extends EnvironmentError {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null, options?: { cause?: unknown }) {
    super("sshFailed", message, options);
    this.name = "SshFailureError";
    this.exitCode = exitCode;
  }
}

export class SshDisconnectedError extends EnvironmentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("sshDisconnected", message, options);
    this.name = "SshDisconnectedError";
  }
}

export class HostKeyMissingError extends EnvironmentError {
  readonly host: string;

  constructor(host: string) {
    super("hostKeyMissing", `no pinned host key for ${host} in the dedicated known-hosts file`);
    this.name = "HostKeyMissingError";
    this.host = host;
  }
}

/** The key the computer presented is not the one pinned. Reconnecting needs a
 * new confirmation; this layer never overwrites the pin on its own. */
export class HostKeyChangedError extends EnvironmentError {
  readonly host: string;
  readonly expected: string;
  readonly presented: string | null;

  constructor(host: string, expected: string, presented: string | null) {
    super("hostKeyChanged", `the host key for ${host} changed: pinned ${expected}, presented ${presented ?? "nothing"}`);
    this.name = "HostKeyChangedError";
    this.host = host;
    this.expected = expected;
    this.presented = presented;
  }
}

/**
 * A first connection with no fingerprint to check against. A scan may have found
 * keys, but a scanned key is not a trusted key: the person must confirm a
 * fingerprint, and this error carries what the scan saw so a screen can show it.
 */
export class HostKeyConfirmationRequiredError extends EnvironmentError {
  readonly host: string;
  readonly scannedFingerprints: readonly string[];

  constructor(host: string, scannedFingerprints: readonly string[] = []) {
    super(
      "hostKeyConfirmationRequired",
      scannedFingerprints.length === 0
        ? `no host key fingerprint was given for ${host} and a scan found none; confirm the fingerprint out of band`
        : `no host key fingerprint was given for ${host}; the scan offered ${scannedFingerprints.join(", ")}, which needs your confirmation`,
    );
    this.name = "HostKeyConfirmationRequiredError";
    this.host = host;
    this.scannedFingerprints = scannedFingerprints;
  }
}

export class FingerprintMismatchError extends EnvironmentError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super("fingerprintMismatch", `the pinned fingerprint ${expected} does not match the key in the known-hosts file (${actual})`);
    this.name = "FingerprintMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Installation and service setup assume the login user, never root. */
export class NotNonRootError extends EnvironmentError {
  readonly user: string | null;

  constructor(user: string | null) {
    super("notNonRoot", `the login user ${user ?? "(unknown)"} is root; this layer installs only into a user account`);
    this.name = "NotNonRootError";
    this.user = user;
  }
}

export class DiskLowError extends EnvironmentError {
  readonly freeBytes: number | null;
  readonly requiredBytes: number;

  constructor(freeBytes: number | null, requiredBytes: number) {
    super("diskLow", `the computer reports ${freeBytes ?? "unknown"} bytes free; ${requiredBytes} are required`);
    this.name = "DiskLowError";
    this.freeBytes = freeBytes;
    this.requiredBytes = requiredBytes;
  }
}

export class VersionMismatchError extends EnvironmentError {
  readonly expected: string;
  readonly actual: string | null;

  constructor(expected: string, actual: string | null) {
    super("versionMismatch", `expected herdr-core ${expected}, the computer has ${actual ?? "none"}`);
    this.name = "VersionMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class InstallChecksumError extends EnvironmentError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super("installChecksum", `the download's sha256 is ${actual}, not the pinned ${expected}`);
    this.name = "InstallChecksumError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class InstallFailedError extends EnvironmentError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("installFailed", message, options);
    this.name = "InstallFailedError";
  }
}

/** A failed install was undone; `recovered` says whether the previous binary
 * was put back. A rollback that itself failed is reported, not hidden. */
export class InstallRolledBackError extends EnvironmentError {
  readonly recovered: boolean;

  constructor(message: string, recovered: boolean, options?: { cause?: unknown }) {
    super("installRolledBack", message, options);
    this.name = "InstallRolledBackError";
    this.recovered = recovered;
  }
}

export class ConfirmationRequiredError extends EnvironmentError {
  readonly action: string;

  constructor(action: string) {
    super("confirmationRequired", `${action} changes the computer and needs an explicit confirmation`);
    this.name = "ConfirmationRequiredError";
    this.action = action;
  }
}
