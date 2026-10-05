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
    const file = Bun.file(data.slice(1));
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type,
    };
  }
  return { bytes: data, contentType: JSON_TYPE };
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
    body?: RequestBody;
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
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", init.body.contentType);
  }
  headers.set("authorization", `Bearer ${session.accessToken}`);
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
  session: Session,
  output: (chunk: Uint8Array) => Promise<void> = defaultOutput,
): Promise<number> {
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`.trim());
    if (res.status === 401) {
      console.error(
        `Run \`${loginHint(session.target)}\` to authenticate again.`,
      );
    }
  }
  if (res.body) {
    for await (const chunk of res.body) {
      await output(chunk);
    }
  }
  return res.ok ? 0 : 1;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultReadStdin(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await Bun.stdin.arrayBuffer());
}

function defaultOutput(chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}
