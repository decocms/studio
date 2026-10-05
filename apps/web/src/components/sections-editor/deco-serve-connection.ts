/**
 * A connection to `deco serve`, the content-protocol server the Blocks CLI
 * runs on the editor's machine. The CLI prints a link,
 * `<studio>/site-editor#endpoint=<url>`, and nothing else: `deco serve` has
 * no token (it checks the browser's `Origin` and the `Host` header instead).
 * A `token=` left in an older link is ignored. Signed in, the same link
 * pasted into the draft selector's "Local" option connects a project to it.
 *
 * Only loopback endpoints are accepted: a link pointing anywhere else would
 * send the editor's edits, uploads and secrets (encrypted to that server's
 * key) to whoever wrote the link.
 */

import { z } from "zod";

/** `deco serve` listens on this machine only (the hosts its Host check accepts). */
export function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "localhost"
    );
  } catch {
    return false;
  }
}

const DecoServeConnectionSchema = z.object({
  /** The protocol endpoint, such as `http://127.0.0.1:4545/rpc`. */
  endpoint: z
    .string()
    .max(2048)
    .refine(
      (value) => isLoopbackEndpoint(value) && new URL(value).pathname === "/rpc",
    ),
});

export type DecoServeConnection = z.infer<typeof DecoServeConnectionSchema>;

/** Reads a connect link's fragment; `null` when it isn't a valid one. */
export function parseConnectFragment(hash: string): DecoServeConnection | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const parsed = DecoServeConnectionSchema.safeParse({
    endpoint: params.get("endpoint") ?? "",
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A stored connection, or `null` for anything else in storage. A `token`
 * saved by an older Studio is dropped.
 */
export function parseStoredConnection(
  value: unknown,
): DecoServeConnection | null {
  const parsed = DecoServeConnectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A whole connect link pasted somewhere (the draft selector's "Local"
 * option): its fragment's connection, or `null` for any other text.
 */
export function parseConnectLink(value: string): DecoServeConnection | null {
  try {
    return parseConnectFragment(new URL(value.trim()).hash);
  } catch {
    return null;
  }
}

const LAST_KEY = "studio:deco-serve-last";

/**
 * Remembers `/site-editor`'s last endpoint in this browser, so opening
 * `/site-editor` with no link reconnects to it.
 */
export function saveLastConnection(connection: DecoServeConnection): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(connection));
  } catch {
    // Storage blocked: `/site-editor` then needs the link again.
  }
}

export function readLastConnection(): DecoServeConnection | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? parseStoredConnection(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearLastConnection(): void {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** `127.0.0.1:4545`: where the endpoint's server listens, for messages. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Probe retries back off from 1s to 10s while `deco serve` is down. */
export function probeRetryDelay(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), 10_000);
}
