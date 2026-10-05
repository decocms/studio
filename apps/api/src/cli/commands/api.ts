import {
  readDataArg,
  type RequestIo,
  requireSession,
  type SessionOptions,
  studioFetch,
  writeResponse,
} from "../lib/studio-request";

export interface ApiOptions extends SessionOptions, RequestIo {
  /** Path on the studio, e.g. `/api/<org>/fs/<volume>/list?path=/`. */
  path?: string;
  /** Defaults to POST when `data` is set, GET otherwise. */
  method?: string;
  /** Request body: literal, `@<file>`, or `@-` for stdin. */
  data?: string;
  /** Extra headers as `Name: value`. */
  headers?: string[];
}

const API_USAGE =
  "Usage: decocms api <path> [-X <method>] [-d <data|@file|@->] [-H 'Name: value']";

/**
 * `decocms api` — authenticated request to any studio route, like `gh api`.
 * Prints the response body to stdout and exits non-zero on a non-2xx status.
 */
export async function apiCommand(options: ApiOptions): Promise<number> {
  if (!options.path) {
    console.error(API_USAGE);
    return 1;
  }

  const headers = new Headers();
  for (const raw of options.headers ?? []) {
    const separator = raw.indexOf(":");
    if (separator <= 0) {
      console.error(`Invalid header "${raw}". Use "Name: value".`);
      return 1;
    }
    headers.append(
      raw.slice(0, separator).trim(),
      raw.slice(separator + 1).trim(),
    );
  }

  const session = await requireSession(options);
  if (!session) return 1;

  const body = await readDataArg(options.data, options.readStdin);
  const method = (options.method ?? (body === undefined ? "GET" : "POST"))
    .trim()
    .toUpperCase();

  let res: Response;
  try {
    res = await studioFetch(session, options.path, {
      method,
      headers,
      body,
      fetch: options.fetch,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  return writeResponse(res, options.output);
}
