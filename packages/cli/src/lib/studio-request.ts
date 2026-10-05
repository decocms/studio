import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { getValidSession } from "./get-valid-session";
import { RefreshFailedError } from "./refresh-session";
import type { Session } from "./session";

export interface SessionOptions {
  dataDir: string;
  /** Studio to use (host-keyed). Omit for the first session on disk. */
  target?: string;
  fetch?: typeof fetch;
  /** Returns the current time in milliseconds. Defaults to Date.now. */
  now?: () => number;
}

export interface RequestIo {
  /** Injectable for tests. Defaults to reading all of stdin. */
  readStdin?: () => Promise<Uint8Array<ArrayBuffer>>;
  /** Injectable for tests. Defaults to writing to stdout. */
  output?: (chunk: Uint8Array) => Promise<void>;
}

/** A request body plus the content type its source implies. */
export interface RequestBody {
  bytes: Uint8Array<ArrayBuffer> | string;
  contentType: string;
}

function loginHint(target: string | undefined): string {
  return target
    ? `decocms auth login --target ${target}`
    : "decocms auth login";
}

/**
 * Returns a valid (refreshed if needed) session, or null after telling the
 * user how to log in.
 */
export async function requireSession(
  options: SessionOptions,
): Promise<Session | null> {
  const hint = loginHint(options.target);
  let session: Session | null;
  try {
    session = await getValidSession(options);
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "transient") {
      console.error(
        `Could not refresh session: ${err.message}. Run \`${hint}\` to authenticate.`,
      );
      return null;
    }
    throw err;
  }
  if (!session) {
    console.error(`Not logged in. Run \`${hint}\` to authenticate.`);
  }
  return session;
}

const JSON_TYPE = "application/json";

/**
 * Resolves a `--data` value: `@-` reads stdin, `@<file>` reads the file and
 * types it by extension, anything else is the literal body. Literals and
 * stdin are typed as JSON, the common case for both.
 */
export async function readDataArg(
  data: string | undefined,
  readStdin: () => Promise<Uint8Array<ArrayBuffer>> = defaultReadStdin,
): Promise<RequestBody | undefined> {
  if (data === undefined) return undefined;
  if (data === "@-") {
    return { bytes: await readStdin(), contentType: JSON_TYPE };
  }
  if (data.startsWith("@")) {
    const path = data.slice(1);
    return {
      bytes: new Uint8Array(await readFile(path)),
      contentType: contentTypeFor(path),
    };
  }
  return { bytes: data, contentType: JSON_TYPE };
}

/** A bearer credential for Studio's REST routes. */
export interface RestAuth {
  target: string;
  token: string;
  kind: "apiKey" | "session";
}

/**
 * Sends an authenticated request to the credential's studio. `path` must
 * resolve to that studio's origin, so the token never leaves it.
 */
export async function studioFetch(
  auth: RestAuth,
  path: string,
  init: {
    method: string;
    headers?: Headers;
    body?: RequestBody;
    fetch?: typeof fetch;
  },
): Promise<Response> {
  const origin = new URL(auth.target).origin;
  const url = new URL(path, auth.target);
  if (!path.startsWith("/") || url.origin !== origin) {
    throw new Error(
      `Path must start with "/" and stay on ${origin}; got "${path}".`,
    );
  }
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", init.body.contentType);
  }
  headers.set("authorization", `Bearer ${auth.token}`);
  return (init.fetch ?? fetch)(url, {
    method: init.method,
    headers,
    body: init.body?.bytes,
  });
}

/**
 * Streams the response body to stdout (error bodies too, so callers can parse
 * them) and returns the exit code: 0 for 2xx, 1 otherwise.
 */
export async function writeResponse(
  res: Response,
  auth: RestAuth,
  output: (chunk: Uint8Array) => Promise<void> = defaultOutput,
): Promise<number> {
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`.trim());
    if (res.status === 401) {
      console.error(
        auth.kind === "session"
          ? `Run \`${loginHint(auth.target)}\` to authenticate again.`
          : "Studio rejected STUDIO_API_KEY.",
      );
    }
  }
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    await output(value);
  }
  return res.ok ? 0 : 1;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Types for the files people upload most; anything else is opaque bytes. */
const CONTENT_TYPES: Record<string, string> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
};

function contentTypeFor(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

async function defaultReadStdin(): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function defaultOutput(chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}
