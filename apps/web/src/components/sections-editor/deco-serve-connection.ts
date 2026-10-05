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

import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import { z } from "zod";

/** `deco serve` listens on this machine only (the hosts its Host check accepts). */
export function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "[::1]" || host === "localhost";
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
      (value) =>
        isLoopbackEndpoint(value) && new URL(value).pathname === "/rpc",
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

/** Probe retries back off from 1s to `capMs` while `deco serve` is down. */
export function probeRetryDelay(failures: number, capMs = 10_000): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), capMs);
}

/** Where `deco serve` listens when it isn't given `--port`. */
export const DEFAULT_SERVE_ENDPOINT = "http://127.0.0.1:4545/rpc";

/** The command that starts `deco serve` (the `deco` bin of `@decocms/blocks`). */
export const SERVE_COMMAND = "npx @decocms/blocks serve";

/** The command that writes `.deco/schema.gen.json`. */
export const SCHEMA_COMMAND = "npx @decocms/blocks schema";

/** The origins `deco serve` answers without `--allow-origin`. */
const DECO_SERVE_DEFAULT_ORIGINS = new Set([
  "https://studio.decocms.com",
  "https://admin.decocms.com",
  "https://admin.deco.cx",
]);

/** Whether Studio at `origin` needs `deco serve --allow-origin <origin>`. */
export function needsAllowOrigin(origin: string): boolean {
  return !DECO_SERVE_DEFAULT_ORIGINS.has(origin);
}

/** The command to copy: `--allow-origin` only off the official origins. */
export function serveCommand(origin: string): string {
  return needsAllowOrigin(origin)
    ? `${SERVE_COMMAND} --allow-origin ${origin}`
    : SERVE_COMMAND;
}

export type ParsedServeAddress =
  | { ok: true; connection: DecoServeConnection }
  | { ok: false; reason: "not-local" | "unrecognized" };

/**
 * What someone typed into "Using another port?": the Site editor link
 * `deco serve` printed, an address (`127.0.0.1:4547`, `localhost:4547`,
 * `http://127.0.0.1:4547/rpc`) or just a port (`4547`). Always resolves to
 * the server's `/rpc` endpoint; only this machine is accepted.
 */
export function parseServeAddress(input: string): ParsedServeAddress {
  const value = input.trim();
  if (!value) return { ok: false, reason: "unrecognized" };
  const fromLink = parseConnectLink(value);
  if (fromLink) return { ok: true, connection: fromLink };
  if (/^\d{1,5}$/.test(value)) {
    const port = Number(value);
    if (port < 1 || port > 65_535) return { ok: false, reason: "unrecognized" };
    return {
      ok: true,
      connection: { endpoint: `http://127.0.0.1:${port}/rpc` },
    };
  }
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`,
    );
  } catch {
    return { ok: false, reason: "unrecognized" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unrecognized" };
  }
  // A Site editor link whose endpoint isn't a usable one.
  const linked = new URLSearchParams(url.hash.replace(/^#/, "")).get(
    "endpoint",
  );
  if (linked !== null) {
    return {
      ok: false,
      reason: isLoopbackEndpoint(linked) ? "unrecognized" : "not-local",
    };
  }
  if (!isLoopbackEndpoint(url.href)) {
    return {
      ok: false,
      reason: /[.:]/.test(url.host) ? "not-local" : "unrecognized",
    };
  }
  if (url.pathname !== "/" && url.pathname !== "/rpc") {
    return { ok: false, reason: "unrecognized" };
  }
  if (!url.port) return { ok: false, reason: "unrecognized" };
  return {
    ok: true,
    connection: { endpoint: `${url.protocol}//${url.host}/rpc` },
  };
}

/**
 * Why a `deco serve` endpoint can't be used, in the words the site editor
 * explains it with:
 * - `not-answering`: nothing answered (stopped, restarting, another port, or a
 *   refused origin or Chrome permission, which a browser can't tell apart);
 * - `outdated`: an older `deco serve`, which asked for an access token;
 * - `version-mismatch`: a `deco serve` of another major protocol version;
 * - `not-deco-serve`: another program answered on that port;
 * - `error`: `deco serve` answered with an error (`detail`).
 */
export type ServeProblemReason =
  | "not-answering"
  | "outdated"
  | "version-mismatch"
  | "not-deco-serve"
  | "error";

export interface ServeProblem {
  reason: ServeProblemReason;
  /** The server's own message, for `error`. */
  detail?: string;
}

/** Thrown by a probe whose server answered, but isn't `deco serve`. */
export class NotDecoServeError extends Error {
  constructor(message = "the endpoint isn't deco serve") {
    super(message);
    this.name = "NotDecoServeError";
  }
}

/** Sorts a failed probe into the reason the site editor explains. */
export function classifyServeProbeError(error: unknown): ServeProblem {
  if (error instanceof NotDecoServeError) return { reason: "not-deco-serve" };
  if (!(error instanceof ContentProtocolError)) {
    // `TypeError: Failed to fetch`, an abort or a timeout.
    return { reason: "not-answering" };
  }
  switch (error.code) {
    case ErrorCode.Unauthorized:
      return { reason: "outdated" };
    case ErrorCode.Unsupported:
      return { reason: "version-mismatch" };
    case ErrorCode.Unavailable:
      // The client's own: an HTTP answer without a JSON-RPC body.
      if (/^the endpoint answered HTTP/.test(error.message)) {
        return { reason: "not-deco-serve" };
      }
      return { reason: "error", detail: error.message };
    default:
      return { reason: "error", detail: error.message };
  }
}

const DISCONNECTED_KEY = "studio:deco-serve-disconnected";

/**
 * Endpoints disconnected in this tab's session: `/site-editor` won't find
 * them on its own again, or Disconnect would reconnect at once.
 */
export function readDisconnected(): string[] {
  try {
    const raw = sessionStorage.getItem(DISCONNECTED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function markDisconnected(endpoint: string): void {
  try {
    const next = [...new Set([...readDisconnected(), endpoint])];
    sessionStorage.setItem(DISCONNECTED_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: discovery may find it again.
  }
}

export function unmarkDisconnected(endpoint: string): void {
  try {
    const next = readDisconnected().filter((item) => item !== endpoint);
    sessionStorage.setItem(DISCONNECTED_KEY, JSON.stringify(next));
  } catch {
    // Nothing to clear.
  }
}

/**
 * The endpoints `/site-editor` looks for on its own: the last one used, then
 * the default port; minus any disconnected in this session.
 */
export function discoveryCandidates(
  remembered: DecoServeConnection | null,
  disconnected: readonly string[],
): string[] {
  const all = [remembered?.endpoint, DEFAULT_SERVE_ENDPOINT].filter(
    (endpoint): endpoint is string => !!endpoint,
  );
  return [...new Set(all)].filter(
    (endpoint) => !disconnected.includes(endpoint),
  );
}
