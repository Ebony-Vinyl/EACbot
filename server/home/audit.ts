// Every home command that left the host, in order, with what came back. Append-only JSONL beside the other
// data: a receipt a person can point at, not a log a bot can rewrite.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { HomeAction, HomeReceipt, HomeReceiptStatus } from "../../shared/home.ts";

const FILE = "home-audit.jsonl";
const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface HomeAuditEntry {
  at: string;
  receiptId: string;
  entityId: string;
  entityName: string;
  action: HomeAction;
  status: HomeReceiptStatus;
  /** Who asked: a bot's id, or `person` when the view sent it. */
  actor: string;
  threadId?: string;
  /** The value the command carried, as it was sent. */
  value?: string | number | boolean;
  code?: string;
  message?: string;
}

export interface HomeAuditOptions {
  dataDir: string;
  now?: () => string;
}

/** The append-only record of home commands. A read never rewrites it; there is no delete. */
export class HomeAudit {
  private readonly file: string;
  private readonly now: () => string;

  constructor(options: HomeAuditOptions) {
    this.file = join(options.dataDir, FILE);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  record(receipt: HomeReceipt, actor: string, extra: { threadId?: string; entityName?: string; value?: string | number | boolean } = {}): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const entry: HomeAuditEntry = {
      at: this.now(),
      receiptId: receipt.receiptId,
      entityId: receipt.entityId,
      entityName: extra.entityName ?? receipt.observed?.name ?? receipt.entityId,
      action: receipt.action,
      status: receipt.status,
      actor,
      ...(extra.threadId ? { threadId: extra.threadId } : {}),
      ...(extra.value === undefined ? {} : { value: extra.value }),
      ...(receipt.code ? { code: receipt.code } : {}),
      ...(receipt.message ? { message: receipt.message.slice(0, 500) } : {}),
    };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** The newest entries first, bounded so a year of commands does not arrive at once. */
  recent(limit = 100): HomeAuditEntry[] {
    if (!existsSync(this.file)) return [];
    const text = readFileSync(this.file, "utf8");
    const window = text.length > MAX_READ_BYTES ? text.slice(text.length - MAX_READ_BYTES) : text;
    const lines = window.split("\n").filter(Boolean);
    const entries: HomeAuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as HomeAuditEntry);
      } catch {}
    }
    return entries.slice(-Math.min(Math.max(limit, 1), 1_000)).reverse();
  }
}
