import { readFile } from "node:fs/promises";
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

/**
 * Returns a valid (refreshed if needed) session, or null after telling the
 * user how to log in.
 */
export async function requireSession(
  options: SessionOptions,
): Promise<Session | null> {
  const loginHint = options.target
    ? `decocms auth login --target ${options.target}`
    : "decocms auth login";
  let session: Session | null;
  try {
    session = await getValidSession(options);
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "transient") {
      console.error(
        `Could not refresh session: ${err.message}. Run \`${loginHint}\` to authenticate.`,
      );
      return null;
    }
    throw err;
  }
  if (!session) {
    console.error(`Not logged in. Run \`${loginHint}\` to authenticate.`);
  }
  return session;
}

/**
 * Resolves a `--data` value: `@-` reads stdin, `@<file>` reads the file,
 * anything else is the literal body.
 */
export async function readDataArg(
  data: string | undefined,
  readStdin: () => Promise<Uint8Array<ArrayBuffer>> = defaultReadStdin,
): Promise<Uint8Array<ArrayBuffer> | string | undefined> {
  if (data === undefined) return undefined;
  if (data === "@-") return readStdin();
  if (data.startsWith("@"))
    return new Uint8Array(await readFile(data.slice(1)));
  return data;
}

/**
 * Sends an authenticated request to the session's studio. `path` must resolve
 * to the same origin as the session, so the token never leaves that studio.
 */
export async function studioFetch(
  session: Session,
  path: string,
  init: {
    method: string;
    headers?: Headers;
    body?: Uint8Array<ArrayBuffer> | string;
    fetch?: typeof fetch;
  },
): Promise<Response> {
  const origin = new URL(session.target).origin;
  const url = new URL(path, session.target);
  if (!path.startsWith("/") || url.origin !== origin) {
    throw new Error(
      `Path must start with "/" and stay on ${origin}; got "${path}".`,
    );
  }
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("authorization", `Bearer ${session.accessToken}`);
  return (init.fetch ?? fetch)(url, {
    method: init.method,
    headers,
    body: init.body,
  });
}

/**
 * Streams the response body to stdout (error bodies too, so callers can parse
 * them) and returns the exit code: 0 for 2xx, 1 otherwise.
 */
export async function writeResponse(
  res: Response,
  output: (chunk: Uint8Array) => Promise<void> = defaultOutput,
): Promise<number> {
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`.trim());
    if (res.status === 401) {
      console.error("Run `decocms auth login` to authenticate again.");
    }
  }
  if (res.body) {
    for await (const chunk of res.body) {
      await output(chunk);
    }
  }
  return res.ok ? 0 : 1;
}

async function defaultReadStdin(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.stdin.arrayBuffer());
}

function defaultOutput(chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}
