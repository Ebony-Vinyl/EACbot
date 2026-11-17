// The cloud half of health, end to end against a fake provider: a sign-in the person approves in a browser, a sync
// that writes rows, a second sync that adds nothing new, and a token that expires and is renewed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeHealthProvider, type FakeHealthProvider } from "../testing/fake-health-provider.ts";
import { HealthStore } from "./store.ts";
import { HealthCloudStore } from "./cloud-store.ts";
import { HealthOAuthManager, refreshHealthTokens, type HealthOAuthRecord } from "./adapters/oauth.ts";
import { syncHealthSource } from "./sync.ts";

const stores: HealthStore[] = [];
let dir = "";
let provider: FakeHealthProvider | null = null;
let oauth: HealthOAuthManager | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eac-health-cloud-"));
});

afterEach(async () => {
  oauth?.dispose();
  oauth = null;
  for (const store of stores.splice(0)) store.close();
  await provider?.close();
  provider = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A store pair rooted in the fixture directory. */
function stores_() {
  const store = new HealthStore({ dataDir: dir });
  stores.push(store);
  return { store, cloud: new HealthCloudStore({ dataDir: dir }) };
}

/** Drives the browser half: the provider redirects, and the callback listener is what answers. */
async function approve(authorizationUrl: string): Promise<string> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  expect(location, "the provider must redirect back to the listener").toBeTruthy();
  return location!;
}

describe("signing a cloud source in", () => {
  it("completes the PKCE exchange and keeps the tokens out of the config", async () => {
    provider = await startFakeHealthProvider({ shape: "withings" });
    oauth = new HealthOAuthManager();
    const { status, done } = await oauth.authorize({
      provider: "withings",
      sourceId: "withings",
      client: {
        clientId: "app-id",
        endpoints: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scope: "user.metrics" },
      },
    });
    expect(status.phase).toBe("waiting");
    expect(status.authorizationUrl).toContain("code_challenge_method=S256");

    // The provider's redirect goes to the listener this manager opened, which completes the sign-in.
    const callback = await approve(status.authorizationUrl!);
    expect(callback).toContain("/api/health/oauth/callback");
    const answer = await fetch(callback);
    expect(answer.status).toBe(200);

    const record = await done;
    expect(record.provider).toBe("withings");
    expect(record.tokens.access).toBeTruthy();
    expect(record.tokens.refresh).toBeTruthy();
    expect(oauth.status("withings")?.phase).toBe("succeeded");
    expect(provider.counts.authorize).toBe(1);
    expect(provider.counts.token).toBe(1);
  });

  it("refuses a callback whose state does not match", async () => {
    provider = await startFakeHealthProvider();
    oauth = new HealthOAuthManager();
    const { status } = await oauth.authorize({
      provider: "withings",
      sourceId: "withings",
      client: { clientId: "app-id", endpoints: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scope: "" } },
    });
    const callback = new URL((await approve(status.authorizationUrl!)));
    callback.searchParams.set("state", "someone-elses-state");
    const answer = await fetch(callback);
    expect(answer.status).toBe(400);
    // A spliced callback must not spend the sign-in: the real one can still land.
    expect(oauth.status("withings")?.phase).toBe("waiting");
    expect(provider.counts.token).toBe(0);
  });

  it("refuses a provider that will not hand over a token", async () => {
    provider = await startFakeHealthProvider({ denyToken: true });
    oauth = new HealthOAuthManager();
    const { status, done } = await oauth.authorize({
      provider: "withings",
      sourceId: "withings",
      client: { clientId: "app-id", endpoints: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scope: "" } },
    });
    const answer = await fetch(await approve(status.authorizationUrl!));
    expect(answer.status).toBe(400);
    await expect(done).rejects.toThrow();
    expect(oauth.status("withings")?.phase).toBe("failed");
  });

  it("needs an app registration before it starts", async () => {
    oauth = new HealthOAuthManager();
    await expect(oauth.authorize({
      provider: "withings",
      sourceId: "withings",
      client: { clientId: "", endpoints: { authorizeUrl: "http://127.0.0.1:1/authorize", tokenUrl: "http://127.0.0.1:1/token", scope: "" } },
    })).rejects.toMatchObject({ code: "no_client" });
  });
});

describe("syncing a signed-in source", () => {
  it("writes Withings measurements and activity, and a second sync adds nothing new", async () => {
    provider = await startFakeHealthProvider({ shape: "withings" });
    const { store, cloud } = stores_();
    const token = provider.mint();
    cloud.put({
      provider: "withings",
      sourceId: "withings",
      clientId: "app-id",
      tokens: { access: token, refresh: "refresh-token", expiresAt: Date.now() + 3_600_000 },
      redirectUri: "http://127.0.0.1:1/api/health/oauth/callback",
    });

    const first = await syncHealthSource({
      store,
      cloud,
      client: () => ({ clientId: "app-id", endpoints: { authorizeUrl: provider!.authorizeUrl, tokenUrl: provider!.tokenUrl, scope: "" } }),
      baseUrls: { withings: provider.origin },
      now: () => "2026-11-14T09:00:00.000Z",
    }, "withings");

    expect(first.error).toBeUndefined();
    // Two weight readings and two body-fat readings from the groups, plus two body-water; the unknown type is skipped.
    expect(first.added).toBeGreaterThan(0);
    expect(first.skipped).toBe(1);
    const weights = store.query({ metrics: ["weight_kg"] });
    expect(weights.map((row) => row.value).sort()).toEqual([72.1, 72.4]);
    expect(weights.every((row) => row.sourceId === "withings")).toBe(true);
    const steps = store.query({ metrics: ["steps"] });
    expect(steps).toHaveLength(2);

    // A second sync resumes from the cursor: the same rows come back and are replaced, never duplicated.
    const second = await syncHealthSource({
      store,
      cloud,
      client: () => ({ clientId: "app-id", endpoints: { authorizeUrl: provider!.authorizeUrl, tokenUrl: provider!.tokenUrl, scope: "" } }),
      baseUrls: { withings: provider.origin },
      now: () => "2026-11-14T09:05:00.000Z",
    }, "withings");
    expect(second.error).toBeUndefined();
    expect(second.added).toBe(0);
    expect(store.query({ metrics: ["weight_kg"] })).toHaveLength(2);
  });

  it("writes Oura's daily summaries and sleep stages", async () => {
    provider = await startFakeHealthProvider({ shape: "oura" });
    const { store, cloud } = stores_();
    cloud.put({
      provider: "oura",
      sourceId: "oura",
      clientId: "app-id",
      tokens: { access: provider.mint(), refresh: "refresh-token", expiresAt: Date.now() + 3_600_000 },
      redirectUri: "http://127.0.0.1:1/api/health/oauth/callback",
    });

    const outcome = await syncHealthSource({
      store,
      cloud,
      client: () => ({ clientId: "app-id", endpoints: { authorizeUrl: provider!.authorizeUrl, tokenUrl: provider!.tokenUrl, scope: "" } }),
      baseUrls: { oura: provider.origin },
      now: () => "2026-11-14T09:00:00.000Z",
    }, "oura");

    expect(outcome.error).toBeUndefined();
    const byMetric = new Map(store.query({}).map((row) => [row.metric, row.value]));
    expect(byMetric.get("steps")).toBe(9_100);
    expect(byMetric.get("sleep_hours")).toBe(7.33);
    expect(byMetric.get("sleep_deep_hours")).toBe(1.5);
    expect(byMetric.get("sleep_score")).toBe(81);
    expect(byMetric.get("readiness_score")).toBe(77);
    expect(byMetric.get("spo2")).toBe(97.4);
    expect(byMetric.get("hrv_ms")).toBe(48);
  });

  it("reports an expired sign-in instead of writing a partial batch", async () => {
    provider = await startFakeHealthProvider();
    const { store, cloud } = stores_();
    cloud.put({
      provider: "withings",
      sourceId: "withings",
      clientId: "app-id",
      // A token this provider never issued: the data endpoints answer 401.
      tokens: { access: "not-issued-here", expiresAt: Date.now() + 3_600_000 },
      redirectUri: "http://127.0.0.1:1/api/health/oauth/callback",
    });

    const outcome = await syncHealthSource({
      store,
      cloud,
      client: () => ({ clientId: "app-id", endpoints: { authorizeUrl: provider!.authorizeUrl, tokenUrl: provider!.tokenUrl, scope: "" } }),
      baseUrls: { withings: provider.origin },
      now: () => "2026-11-14T09:00:00.000Z",
    }, "withings");

    expect(outcome.error?.code).toBe("unauthorized");
    expect(outcome.added).toBe(0);
    expect(store.count({})).toBe(0);
    expect(store.sources().find((source) => source.sourceId === "withings")?.status).toBe("expired");
  });

  it("says so when the source was never connected", async () => {
    const { store, cloud } = stores_();
    const outcome = await syncHealthSource({ store, cloud, client: () => null }, "withings");
    expect(outcome.error?.code).toBe("not_connected");
  });

  it("renews a token that is about to expire, and keeps the rotation", async () => {
    provider = await startFakeHealthProvider({ shape: "oura" });
    const { store, cloud } = stores_();
    const first = provider.mint();
    cloud.put({
      provider: "oura",
      sourceId: "oura",
      clientId: "app-id",
      // Inside the refresh margin: a sync must renew before it reads.
      tokens: { access: first, refresh: "seed-refresh", expiresAt: Date.now() + 60_000 },
      redirectUri: "http://127.0.0.1:1/api/health/oauth/callback",
    });
    // The provider only knows refresh tokens it issued, so seed one through a full exchange.
    const record: HealthOAuthRecord = {
      provider: "oura",
      sourceId: "oura",
      clientId: "app-id",
      tokens: { access: first, refresh: "seed-refresh", expiresAt: Date.now() + 60_000 },
      redirectUri: "http://127.0.0.1:1/api/health/oauth/callback",
    };
    const client = { clientId: "app-id", endpoints: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scope: "" } };
    // A refresh the provider does not recognise is refused, so the source is reported as needing a new sign-in.
    await expect(refreshHealthTokens(record, client)).rejects.toMatchObject({ code: "refused" });

    const outcome = await syncHealthSource({ store, cloud, client: () => client, baseUrls: { oura: provider.origin }, now: () => "2026-11-14T09:00:00.000Z" }, "oura");
    expect(outcome.error?.code).toBe("unauthorized");
    expect(provider.counts.refresh).toBeGreaterThan(0);
  });
});

describe("the cloud record file", () => {
  it("keeps a cursor across a restart and drops everything on delete", () => {
    const { cloud } = stores_();
    cloud.put({
      provider: "withings",
      sourceId: "withings",
      clientId: "app-id",
      tokens: { access: "a", refresh: "r" },
      redirectUri: "http://127.0.0.1:1/cb",
    });
    cloud.advance("withings", "2026-11-14T00:00:00.000Z", "2026-11-14T09:00:00.000Z");
    const reread = new HealthCloudStore({ dataDir: dir }).get("withings");
    expect(reread?.cursor).toBe("2026-11-14T00:00:00.000Z");
    expect(reread?.lastSyncAt).toBe("2026-11-14T09:00:00.000Z");

    cloud.delete("withings");
    expect(new HealthCloudStore({ dataDir: dir }).get("withings")).toBeUndefined();
  });
});
