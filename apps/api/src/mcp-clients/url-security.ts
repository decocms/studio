import { lookup } from "node:dns/promises";

/** RFC 1918 / loopback / link-local ranges, keyed off the first two IPv4 octets. */
function isPrivateIPv4Octets(a: number, b: number | undefined): boolean {
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  // RFC 6598 Shared Address Space (100.64.0.0/10) — CGNAT range also used by
  // cloud providers for internal service/metadata endpoints (e.g. Alibaba
  // Cloud's 100.100.100.200 metadata server).
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

/** Decode the first IPv6 hex word (16 bits) into the first two IPv4 octets. */
function hexWordToIPv4(word: string): [number, number] {
  const value = Number.parseInt(word.padStart(4, "0"), 16);
  return [value >> 8, value & 0xff];
}

/**
 * IPv6 transition mechanisms (6to4, NAT64) embed a literal IPv4 address in the
 * hostname. A private IPv4 embedded this way must be blocked the same as the
 * plain dotted form, or it bypasses the SSRF guard below.
 */
function isPrivateEmbeddedIPv4(ipv6: string): boolean {
  const groups = ipv6.split(":").filter((g) => g.length > 0);

  // 6to4: 2002:WWXX:YYZZ:... — embedded IPv4's first two octets are word WWXX.
  if (ipv6.startsWith("2002:") && groups.length >= 2) {
    const [a, b] = hexWordToIPv4(groups[1]!);
    if (isPrivateIPv4Octets(a, b)) return true;
  }

  // NAT64: 64:ff9b::WWXX:YYZZ — embedded IPv4's first two octets are the
  // second-to-last word (well-known /96 prefix, IPv4 in the last 32 bits).
  if (ipv6.startsWith("64:ff9b::") && groups.length >= 4) {
    const [a, b] = hexWordToIPv4(groups[groups.length - 2]!);
    if (isPrivateIPv4Octets(a, b)) return true;
  }

  // IPv4-compatible IPv6 (deprecated, RFC 4291): dotted ::a.b.c.d input is
  // always normalized by `new URL()` into compressed hex (e.g. ::127.0.0.1
  // becomes ::7f00:1) before we ever see the hostname, so it collapses to
  // exactly "::" + 2 hex words — same shape as the 6to4 case above.
  if (ipv6.startsWith("::") && groups.length === 2) {
    const [a, b] = hexWordToIPv4(groups[0]!);
    if (isPrivateIPv4Octets(a, b)) return true;
  }

  return false;
}

export function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".localhost")
    ) {
      return true;
    }

    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (isPrivateIPv4Octets(a!, b)) return true;
    }

    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      const ipv6 = hostname.slice(1, -1).toLowerCase();
      if (ipv6 === "::1" || ipv6 === "::") return true;
      if (ipv6.startsWith("::ffff:")) return true;
      if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;
      if (ipv6.startsWith("fe80")) return true;
      if (ipv6.startsWith("100:")) return true;
      if (ipv6.startsWith("::1")) return true;
      if (isPrivateEmbeddedIPv4(ipv6)) return true;
    }

    return false;
  } catch {
    return true;
  }
}

/** Checks a bare resolved IP literal (v4 or v6, no brackets) against private/loopback/link-local ranges — used to vet DNS resolution results, since `isPrivateUrl` only sees the literal hostname written in the URL. */
function isPrivateIpAddress(ip: string): boolean {
  const ipv4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    return isPrivateIPv4Octets(a!, b);
  }

  const ipv6 = ip.toLowerCase();
  if (ipv6 === "::1" || ipv6 === "::") return true;
  if (ipv6.startsWith("::ffff:")) return true;
  if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;
  if (ipv6.startsWith("fe80")) return true;
  if (ipv6.startsWith("100:")) return true;
  return isPrivateEmbeddedIPv4(ipv6);
}

/**
 * A hostname's IP-literal form is vetted synchronously by `isPrivateUrl`, but
 * a plain domain name only reveals its real destination after DNS
 * resolution — an attacker who controls DNS for their own domain (e.g. an A
 * record pointing at the 169.254.169.254 cloud metadata endpoint) bypasses
 * the literal-IP guard entirely. Resolve first and vet every returned
 * address before connecting.
 */
export async function resolvesToPrivateAddress(
  hostname: string,
  resolveHost: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((r) => r.address),
): Promise<boolean> {
  try {
    const addresses = await resolveHost(hostname);
    return addresses.length === 0 || addresses.some(isPrivateIpAddress);
  } catch {
    // Can't verify where this hostname actually points — fail closed.
    return true;
  }
}

/**
 * Full SSRF guard for a remote MCP URL: rejects private/loopback/link-local
 * IP literals synchronously via `isPrivateUrl`, then — for a plain hostname —
 * resolves DNS and rejects if any resolved address is private. Shared by
 * every code path that connects to a user-supplied MCP server URL, so a
 * caller can't bypass the registry discovery guard by hitting a different
 * entry point (e.g. connection create/update) with the same URL.
 */
export async function guardAgainstPrivateUrl(
  url: string,
): Promise<string | null> {
  const blockedMessage = "URLs targeting private networks are not allowed";

  if (isPrivateUrl(url)) {
    return blockedMessage;
  }

  // isPrivateUrl already fully vets an IP-literal hostname; only a plain
  // domain name needs a DNS lookup to catch a domain whose DNS record
  // points at a private/metadata address.
  const hostname = new URL(url).hostname;
  const isIpLiteral =
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    (hostname.startsWith("[") && hostname.endsWith("]"));
  if (isIpLiteral) return null;

  try {
    const blocked = await withTimeout(
      resolvesToPrivateAddress(hostname),
      5_000,
      "DNS resolution timeout",
    );
    return blocked ? blockedMessage : null;
  } catch {
    return blockedMessage; // can't verify in time — fail closed
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps `fetch` to refuse 3xx redirects. `isPrivateUrl` and the DNS check
 * above only vet the URL we're about to connect to — the MCP SDK's client
 * transports follow redirects by default, so a malicious/compromised remote
 * server could 3xx-redirect the `tools/list` request to a private/metadata
 * address and bypass both checks.
 */
export function createNoRedirectFetch(
  fetchImpl: (
    url: string | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const res = await fetchImpl(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      throw new Error("Refusing to follow a redirect from the remote server");
    }
    return res;
  };
}
