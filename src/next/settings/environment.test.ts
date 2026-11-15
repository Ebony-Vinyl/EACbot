import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT, SECRET_FIELDS, carriesSecret, describeConnection, environmentRequest, hasPin, hostKeyWarning,
  isDraftValid, parsePort, validateDraft, type SshDraft,
} from "./environment.ts";

const valid: SshDraft = {
  label: "Office box",
  host: "box.example.com",
  port: "2222",
  user: "deploy",
  fingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
};

describe("the add-my-computer form", () => {
  it("accepts a complete draft", () => {
    expect(validateDraft(valid)).toEqual({});
    expect(isDraftValid(valid)).toBe(true);
  });

  it("asks for no known-hosts path, because this application owns that file", () => {
    expect(Object.keys(EMPTY_DRAFT)).toEqual(["label", "host", "port", "user", "fingerprint"]);
    expect(EMPTY_DRAFT).not.toHaveProperty("knownHostsFile");
  });

  it("accepts an IPv4 address, a bracketed IPv6 address and a single-label host", () => {
    for (const host of ["10.0.0.4", "[fd00::1]", "buildbox"]) {
      expect(validateDraft({ ...valid, host })).not.toHaveProperty("host");
    }
  });

  it("refuses a host that is a URL or carries a scheme", () => {
    expect(validateDraft({ ...valid, host: "ssh://box.example.com" }).host).toMatch(/host name/u);
    expect(validateDraft({ ...valid, host: "box example.com" }).host).toMatch(/host name/u);
    expect(validateDraft({ ...valid, host: "box.example.com/path" }).host).toMatch(/host name/u);
  });

  it("refuses a port outside 1–65535 and a non-number", () => {
    for (const port of ["0", "65536", "", "22a", "-1", "8.5"]) expect(validateDraft({ ...valid, port }).port).toBeDefined();
    expect(parsePort("22")).toBe(22);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("65536")).toBeUndefined();
  });

  it("refuses root, because the install target is a non-root account", () => {
    expect(validateDraft({ ...valid, user: "root" }).user).toMatch(/non-root/u);
  });

  it("refuses a user name the remote account cannot have", () => {
    for (const user of ["2deploy", "de ploy", "de:ploy", "-deploy"]) expect(validateDraft({ ...valid, user }).user).toBeDefined();
    expect(validateDraft({ ...valid, user: "_svc" })).not.toHaveProperty("user");
  });

  it("accepts the SHA256 and MD5 forms ssh prints, and nothing else", () => {
    expect(validateDraft({ ...valid, fingerprint: "MD5:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99" })).not.toHaveProperty("fingerprint");
    expect(validateDraft({ ...valid, fingerprint: "SHA256:short" }).fingerprint).toMatch(/SHA256/u);
    expect(validateDraft({ ...valid, fingerprint: "ssh-ed25519 AAAA" }).fingerprint).toMatch(/SHA256/u);
    expect(validateDraft({ ...valid, fingerprint: "" }).fingerprint).toMatch(/fingerprint/u);
  });

  it("names every problem at once so a person fixes the form once", () => {
    const errors = validateDraft(EMPTY_DRAFT);
    expect(Object.keys(errors).sort()).toEqual(["fingerprint", "host", "label", "user"]);
  });
});

describe("what leaves the form", () => {
  it("sends exactly the five connection facts the route accepts", () => {
    const body = environmentRequest(valid) as unknown as Record<string, unknown>;
    expect(body).toEqual({
      label: "Office box",
      host: "box.example.com",
      port: 2222,
      user: "deploy",
      hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
    });
  });

  it("sends no kind, no auth mode and no known-hosts path, which the route refuses", () => {
    const body = environmentRequest(valid) as unknown as Record<string, unknown>;
    for (const field of ["kind", "authMode", "credentialRef", "baseUrl", "knownHostsFile"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("carries no password and no private key under any spelling", () => {
    const body = environmentRequest(valid) as unknown as Record<string, unknown>;
    expect(carriesSecret(body)).toBe(false);
    for (const field of SECRET_FIELDS) expect(body).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toMatch(/password|passphrase|privateKey|BEGIN OPENSSH/u);
  });

  it("refuses to build a request from an invalid draft", () => {
    expect(() => environmentRequest({ ...valid, user: "root" })).toThrow(/non-root/u);
    expect(() => environmentRequest({ ...valid, host: "" })).toThrow(/host/u);
  });

  it("detects a secret-bearing body even when a caller built one by hand", () => {
    expect(carriesSecret({ label: "x", password: "hunter2" })).toBe(true);
    expect(carriesSecret({ privateKeyPath: "/home/u/.ssh/id_ed25519" })).toBe(true);
    expect(carriesSecret({ knownHostsFile: "~/.eacbot/known_hosts" })).toBe(true);
    expect(carriesSecret({ hostKeyFingerprint: "SHA256:x" })).toBe(false);
  });
});

describe("a test connection reports what happened", () => {
  it("never claims a connection that was not made", () => {
    expect(describeConnection(undefined).tone).toBe("error");
    expect(describeConnection(undefined).text).toContain("还没有检查过");
    expect(describeConnection({ reachable: false, checkedAt: "2026-11-15T10:00:00Z" }).tone).toBe("error");
    expect(describeConnection({ reachable: false, detail: "connection refused", checkedAt: "x" }).text).toContain("connection refused");
  });

  it("says no transport reported a reason when the answer carries none", () => {
    expect(describeConnection({ reachable: false, checkedAt: "x" }).text).toContain("没有任何传输层报告原因");
  });

  it("shows the measured latency when the computer answered", () => {
    const described = describeConnection({ reachable: true, latencyMs: 42, checkedAt: "x" });
    expect(described.tone).toBe("success");
    expect(described.text).toContain("42 ms");
  });

  it("shows the server's detail alongside a successful answer", () => {
    expect(describeConnection({ reachable: true, detail: "OpenSSH 9.6", checkedAt: "x" }).text).toContain("OpenSSH 9.6");
  });
});

describe("a changed host key", () => {
  const record = { id: "e1", label: "box", host: "box.example.com", port: 22, user: "deploy", hostKeyFingerprint: "SHA256:aaa" };

  it("says nothing while the status is not a change", () => {
    expect(hostKeyWarning("online")).toBeUndefined();
    expect(hostKeyWarning(undefined)).toBeUndefined();
  });

  it("warns loudly and names the interception risk when the key changed", () => {
    const warning = hostKeyWarning("hostKeyChanged");
    expect(warning).toContain("不一致");
    expect(warning).toContain("拦截");
  });

  it("points at re-adding the computer, because no route re-pins a key in place", () => {
    expect(hostKeyWarning("hostKeyChanged")).toContain("重新添加");
  });

  it("knows when a record has no pin at all", () => {
    expect(hasPin(record)).toBe(true);
    expect(hasPin({ ...record, hostKeyFingerprint: undefined })).toBe(false);
    expect(hasPin({ ...record, hostKeyFingerprint: "  " })).toBe(false);
  });
});
