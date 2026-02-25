/**
 * SSRF Validator
 *
 * Security-critical module that prevents Server-Side Request Forgery (SSRF)
 * by validating and normalizing URLs before any outbound HTTP requests.
 *
 * BLOCKER: This must be in place before any public diagnose endpoint goes live.
 *
 * Two exports:
 * - normalizeUrl: Synchronous normalization (protocol check, host lowercase, etc.)
 * - validateUrl: Async validation including DNS resolution check for private IPs
 */

import dns from "dns";

// ============================================================================
// Types
// ============================================================================

export interface ValidatedUrl {
  url: URL;
  normalized: string;
}

// ============================================================================
// Private IP Detection
// ============================================================================

/**
 * Determine if an IPv4 address belongs to a private or reserved range.
 * Handles IPv4-mapped IPv6 addresses (::ffff:x.x.x.x).
 */
function isPrivateIpv4(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = (mapped ? mapped[1] : ip) ?? ip;

  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [a, b] = parts;

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private class A
  if (a === 10) return true;
  // 172.16.0.0/12 — private class B (172.16.x.x – 172.31.x.x)
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private class C
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local (APIPA)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — unspecified
  if (a === 0) return true;

  return false;
}

/**
 * Determine if an IPv6 address belongs to a private or reserved range.
 */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 — IPv6 loopback
  if (normalized === "::1") return true;

  // fc00::/7 — Unique Local Addresses (fc00:: – fdff::)
  // First byte: 0xfc (11111100) or 0xfd (11111101)
  if (/^f[cd]/i.test(normalized)) return true;

  // fe80::/10 — Link-local
  // First 10 bits = 1111111010 → fe80:: to febf::
  if (/^fe[89ab]/i.test(normalized)) return true;

  return false;
}

/**
 * Check if an IP address (IPv4 or IPv6) is private/reserved.
 * Exported for direct testing.
 */
export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped IPv6
  if (lower.startsWith("::ffff:")) {
    return isPrivateIpv4(ip);
  }

  // Pure IPv4 — contains dots but no colons
  if (ip.includes(".") && !ip.includes(":")) {
    return isPrivateIpv4(ip);
  }

  // IPv6
  if (ip.includes(":")) {
    return isPrivateIpv6(ip);
  }

  return false;
}

// ============================================================================
// URL Normalization
// ============================================================================

/**
 * Normalize a URL for consistent caching and validation.
 *
 * - Prepends https:// if no protocol is specified
 * - Rejects non-HTTP(S) protocols
 * - Lowercases the hostname
 * - Removes default ports (:80 for http, :443 for https)
 * - Removes trailing slash from root path
 * - Strips hash fragments
 *
 * @throws Error with a user-facing message if the URL is invalid
 */
export function normalizeUrl(input: string): ValidatedUrl {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("URL must not be empty");
  }

  // Reject known non-hierarchical protocols BEFORE adding https:// prefix
  // These match a protocol prefix but don't have a //-based authority
  const protocolMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
  if (protocolMatch) {
    const proto = (protocolMatch[1] ?? "").toLowerCase();
    if (proto !== "http" && proto !== "https") {
      throw new Error(
        `Unsupported protocol "${proto}". Only http and https are allowed`,
      );
    }
  }

  // Prepend https:// if no protocol
  let withProtocol = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmed)) {
    withProtocol = `https://${trimmed}`;
  }

  // Parse the URL
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid URL: "${input}"`);
  }

  // Only allow HTTP and HTTPS protocols (belt-and-suspenders check)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported protocol "${parsed.protocol.replace(":", "")}". Only http and https are allowed`,
    );
  }

  // Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();

  // Remove default ports
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  // Strip hash fragment (never sent to server, irrelevant for caching)
  parsed.hash = "";

  // Build normalized string manually to avoid the URL spec always appending "/"
  // for root paths (e.g., "https://example.com/" → "https://example.com")
  const isRootPath = parsed.pathname === "/" && !parsed.search;
  const pathPart = isRootPath ? "" : parsed.pathname;
  const searchPart = parsed.search; // Already includes leading "?" if present
  const portPart = parsed.port ? `:${parsed.port}` : "";
  const normalized = `${parsed.protocol}//${parsed.hostname}${portPart}${pathPart}${searchPart}`;

  return { url: parsed, normalized };
}

// ============================================================================
// URL Validation (async, with DNS resolution)
// ============================================================================

/**
 * Validate a URL for use as a diagnostic target.
 *
 * Performs normalization AND DNS resolution checks to prevent SSRF.
 * Rejects private IP ranges, localhost, non-HTTP protocols, and
 * hostnames that cannot be resolved.
 *
 * @throws Error with a user-facing message if the URL is invalid or unsafe
 */
export async function validateUrl(input: string): Promise<ValidatedUrl> {
  // Step 1: Normalize (throws on bad protocol / malformed URL)
  const result = normalizeUrl(input);
  const { url } = result;

  const hostname = url.hostname;

  // Step 2: Reject localhost immediately (no DNS needed)
  if (hostname === "localhost") {
    throw new Error("URL resolves to a private/internal IP address");
  }

  // Step 3: Reject literal private IP addresses
  if (isPrivateIp(hostname)) {
    throw new Error("URL resolves to a private/internal IP address");
  }

  // Step 4: DNS resolution — check both A and AAAA records
  const ipv4Addresses: string[] = await new Promise((resolve) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) {
        resolve([]);
      } else {
        resolve(addresses);
      }
    });
  });

  const ipv6Addresses: string[] = await new Promise((resolve) => {
    dns.resolve6(hostname, (err, addresses) => {
      if (err) {
        resolve([]);
      } else {
        resolve(addresses);
      }
    });
  });

  const allAddresses = [...ipv4Addresses, ...ipv6Addresses];

  // Step 5: If no addresses resolved at all, reject
  if (allAddresses.length === 0) {
    throw new Error(`Could not resolve hostname: "${hostname}"`);
  }

  // Step 6: Reject if ANY resolved IP is private
  for (const ip of allAddresses) {
    if (isPrivateIp(ip)) {
      throw new Error("URL resolves to a private/internal IP address");
    }
  }

  return result;
}
