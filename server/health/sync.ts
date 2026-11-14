// Pulling a cloud source into the store. This is the only place that pairs a sign-in, an adapter and the store,
// so an adapter stays a pure fetch and the store stays a pure write.
import type { HealthSampleInput } from "../../shared/health.ts";
import type { HealthStore } from "./store.ts";
import type { HealthCloudStore } from "./cloud-store.ts";
import { HealthOAuthError, PROVIDER_ENDPOINTS, refreshHealthTokens, type HealthOAuthClient, type HealthOAuthProvider } from "./adapters/oauth.ts";
import { HealthCloudError } from "./adapters/types.ts";
import { withingsAdapter } from "./adapters/withings.ts";
import { ouraAdapter } from "./adapters/oura.ts";

/** How long before expiry a token is renewed, so a sync never starts on a token that dies mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A first sync reads this far back; a later one resumes from the cursor. */
const FIRST_SYNC_DAYS = 30;
/** A provider's daily data settles late, so each sync re-reads this much of the tail. */
const OVERLAP_HOURS = 36;

export interface HealthSyncOptions {
  store: HealthStore;
  cloud: HealthCloudStore;
  /** The app the person registered, looked up when a token is renewed: a secret is never copied into the store. */
  client(provider: HealthOAuthProvider): HealthOAuthClient | null;
  now?: () => string;
  /** Overrides a provider's production host, for a fixture. */
  baseUrls?: Partial<Record<HealthOAuthProvider, string>>;
}

export interface HealthSyncOutcome {
  sourceId: string;
  added: number;
  replaced: number;
  skipped: number;
  problems: Array<{ row: number; reason: string }>;
  /** Empty when the provider answered; a sentence for the person when it did not. */
  error?: { code: string; message: string };
}

function adapterFor(
  provider: HealthOAuthProvider,
  options: { sourceId: string; accessToken: string; baseUrl?: string },
): ReturnType<typeof withingsAdapter> {
  switch (provider) {
    case "withings":
      return withingsAdapter({ sourceId: options.sourceId, accessToken: options.accessToken, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
    case "oura":
      return ouraAdapter({ sourceId: options.sourceId, accessToken: options.accessToken, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
    default:
      throw new HealthCloudError("not_supported", `this build has no reader for ${provider} yet`);
  }
}

/** The access token to use, renewed and persisted when it is close to expiring. */
async function usableToken(options: HealthSyncOptions, sourceId: string): Promise<string> {
  const record = options.cloud.get(sourceId);
  if (!record) throw new HealthOAuthError("no_client", "this source is not connected");
  const { tokens } = record;
  if (!tokens.expiresAt || tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS) return tokens.access;
  const client = options.client(record.provider);
  if (!client) throw new HealthOAuthError("no_client", `the ${record.provider} app registration is gone; connect this source again`);
  const renewed = await refreshHealthTokens({ ...record, clientId: client.clientId }, client);
  options.cloud.put({ ...renewed, ...(record.cursor ? { cursor: record.cursor } : {}), ...(record.lastSyncAt ? { lastSyncAt: record.lastSyncAt } : {}) });
  return renewed.tokens.access;
}

/** The base URL a provider's data endpoints live at, from the app's configured token endpoint when it overrides one. */
function dataBaseFor(options: HealthSyncOptions, provider: HealthOAuthProvider): string | undefined {
  const configured = options.client(provider);
  const tokenUrl = configured?.endpoints?.tokenUrl;
  if (!tokenUrl) return options.baseUrls?.[provider];
  // A configured token endpoint names the same host the data endpoints live on: a gateway serves both.
  try {
    const url = new URL(tokenUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return options.baseUrls?.[provider];
  }
}

/** Reads one cloud source into the store. Never throws: a failure comes back as an `error` on the outcome. */
export async function syncHealthSource(options: HealthSyncOptions, sourceId: string): Promise<HealthSyncOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const record = options.cloud.get(sourceId);
  if (!record) return { sourceId, added: 0, replaced: 0, skipped: 0, problems: [], error: { code: "not_connected", message: "this source has no sign-in; connect it first" } };

  let accessToken: string;
  try {
    accessToken = await usableToken(options, sourceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.store.upsertSource({
      sourceId,
      kind: "cloud",
      label: sourceId,
      status: "expired",
      credentialRef: null,
      ...(record.lastSyncAt ? { lastSyncAt: record.lastSyncAt } : {}),
    });
    return { sourceId, added: 0, replaced: 0, skipped: 0, problems: [], error: { code: "unauthorized", message } };
  }

  const to = new Date(now());
  const from = record.cursor
    ? new Date(Math.max(Date.parse(record.cursor) - OVERLAP_HOURS * 3_600_000, Date.parse(record.cursor)))
    : new Date(to.getTime() - FIRST_SYNC_DAYS * 86_400_000);

  let result: Awaited<ReturnType<ReturnType<typeof withingsAdapter>["fetch"]>>;
  const baseUrl = dataBaseFor(options, record.provider);
  try {
    result = await adapterFor(record.provider, {
      sourceId,
      accessToken,
      ...(baseUrl ? { baseUrl } : {}),
    }).fetch({ from: from.toISOString(), to: to.toISOString() }, record.cursor);
  } catch (error) {
    const code = error instanceof HealthCloudError ? error.code : "unavailable";
    const message = error instanceof Error ? error.message : String(error);
    options.store.upsertSource({
      sourceId,
      kind: "cloud",
      label: record.provider,
      status: code === "unauthorized" ? "expired" : "unavailable",
      credentialRef: null,
      ...(record.lastSyncAt ? { lastSyncAt: record.lastSyncAt } : {}),
    });
    return { sourceId, added: 0, replaced: 0, skipped: 0, problems: [], error: { code, message } };
  }

  // A provider may hand back the same instant twice (two Withings groups in one second); the store keys on the
  // identity, so the later row wins rather than failing the whole batch.
  const byKey = new Map<string, HealthSampleInput>();
  for (const sample of result.samples) byKey.set(`${sample.metric}\u0000${sample.at}\u0000${sample.endedAt ?? ""}`, sample);
  let written = { added: 0, replaced: 0 };
  try {
    if (byKey.size) written = options.store.write([...byKey.values()]);
  } catch (error) {
    return { sourceId, added: 0, replaced: 0, skipped: result.skipped, problems: result.problems, error: { code: "store_failure", message: error instanceof Error ? error.message : String(error) } };
  }

  const lastSyncAt = now();
  options.cloud.advance(sourceId, result.cursor ?? to.toISOString(), lastSyncAt);
  options.store.upsertSource({
    sourceId,
    kind: "cloud",
    label: record.provider,
    status: "connected",
    credentialRef: null,
    lastSyncAt,
  });
  return { sourceId, added: written.added, replaced: written.replaced, skipped: result.skipped, problems: result.problems };
}

/** Which providers this build can read; a sign-in to one it cannot read is refused before it starts. */
export const READABLE_CLOUD_PROVIDERS: ReadonlySet<HealthOAuthProvider> = new Set(["withings", "oura"]);

export function providerEndpoints(provider: HealthOAuthProvider) {
  return PROVIDER_ENDPOINTS[provider];
}
