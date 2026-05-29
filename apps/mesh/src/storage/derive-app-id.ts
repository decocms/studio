/**
 * Derives a stable, deterministic `app_id` for a connection so that the same
 * service always yields the same id (which is what lets an agent slot resolve
 * to each caller's own connection of that id). Registry connections keep their
 * existing `app_id`; only connections with a null or synthetic `app_id` are
 * (re)derived.
 *
 * Synthetic ids are prefixed `url:` / `stdio:` / `npx:`; the prefix doubles as
 * the marker that distinguishes a derived id (safe to recompute) from a real
 * registry id (never touch).
 */

import {
  type ConnectionParameters,
  isStdioParameters,
} from "../tools/connection/schema";

const SYNTHETIC_PREFIXES = ["url:", "stdio:", "npx:"] as const;

export function isSyntheticAppId(appId: string | null | undefined): boolean {
  return (
    typeof appId === "string" &&
    SYNTHETIC_PREFIXES.some((p) => appId.startsWith(p))
  );
}

export interface DeriveAppIdInput {
  connection_type?: string | null;
  connection_url?: string | null;
  connection_headers?: unknown;
  app_id?: string | null;
}

export function deriveAppId(input: DeriveAppIdInput): string | null {
  // Agents are never a child / slot target.
  if (input.connection_type === "VIRTUAL") return null;

  // Preserve a real registry app_id; only (re)derive null/synthetic ids.
  if (input.app_id && !isSyntheticAppId(input.app_id)) return input.app_id;

  const params = parseHeaders(input.connection_headers);
  if (params && isStdioParameters(params)) {
    return deriveStdioAppId(params);
  }

  if (input.connection_url) {
    const canonical = canonicalizeUrl(input.connection_url);
    if (canonical) return `url:${canonical}`;
  }

  // Nothing derivable — keep whatever was there (or null).
  return input.app_id ?? null;
}

function parseHeaders(headers: unknown): ConnectionParameters | null {
  if (!headers) return null;
  if (typeof headers === "string") {
    try {
      return JSON.parse(headers) as ConnectionParameters;
    } catch {
      return null;
    }
  }
  return headers as ConnectionParameters;
}

function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const host = u.hostname.toLowerCase();
  const defaultPort =
    scheme === "https" ? "443" : scheme === "http" ? "80" : "";
  const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${host}${port}${path}`;
}

function deriveStdioAppId(params: ConnectionParameters): string {
  const stdio = params as { command?: string; args?: string[] };
  const command = (stdio.command ?? "").trim();
  const args = (stdio.args ?? []).map((a) => a.trim());
  if (command === "npx" || command === "bunx") {
    const pkg = args.find((a) => a.length > 0 && !a.startsWith("-"));
    if (pkg) return `npx:${pkg}`;
  }
  return `stdio:${slug([command, ...args].join(" "))}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
