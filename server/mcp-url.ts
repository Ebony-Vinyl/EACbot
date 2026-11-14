/** MCP credentials travel in headers, so plain http is only for an address on this computer. The host is checked as
 * written, never resolved: a public name that happens to resolve to loopback is still a public name. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = host.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) {
    return Number(ipv4[0]) === 127;
  }
  const mappedDotted = /^::ffff:(.+)$/u.exec(host)?.[1];
  if (mappedDotted) {
    const bytes = mappedDotted.split(".");
    if (bytes.length === 4 && bytes.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) {
      return Number(bytes[0]) === 127;
    }
  }
  // URL canonicalises ::ffff:127.0.0.1 to ::ffff:7f00:1, whose first byte is still 127.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  return mappedHex ? (parseInt(mappedHex[1]!, 16) >> 8) === 0x7f : false;
}

/** A remote address reached with plain http: its headers, credentials included, would cross the network in clear text. */
export function insecureRemoteMcpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/** A URL server needs a full address, no credentials in it, and https unless its host is loopback. */
export function remoteMcpUrlError(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Use a full address, like https://example.com/mcp.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "The address must start with http:// or https://.";
  if (parsed.username || parsed.password) return "Put credentials in a header, not in the address.";
  if (insecureRemoteMcpUrl(parsed.href)) {
    return "Use https:// for a remote MCP server. Plain http:// is allowed only for localhost, 127.0.0.1, [::1], or an IPv4-mapped loopback address.";
  }
  return null;
}
