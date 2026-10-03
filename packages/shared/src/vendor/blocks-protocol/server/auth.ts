/**
 * Request authorization shared by the content handler and the asset handler.
 */
import { bearerToken, timingSafeEqualStrings } from "./http";

/**
 * What an `authorize` hook decides:
 * - `true` or `{ scope }` — allowed. `scope` names the tenant and principal,
 *   and scopes request-key receipts, so one tenant never replays another's.
 * - `false` or `"unauthorized"` — a missing or invalid bearer token (HTTP 401).
 * - `"forbidden"` — authenticated, but not allowed for this project.
 */
export type AuthorizeResult =
  | boolean
  | "unauthorized"
  | "forbidden"
  | { scope?: string };

export interface AuthOptions {
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Decides whether a request may proceed (runs after the token check). */
  authorize?: (request: Request) => AuthorizeResult | Promise<AuthorizeResult>;
}

/**
 * Refuses options that would lock every client out by accident: an empty
 * token can never be presented, so every request would be 401.
 */
export function assertAuthOptions(options: AuthOptions): void {
  if (
    options.token !== undefined &&
    (typeof options.token !== "string" || options.token === "")
  ) {
    throw new TypeError(
      "token must be a non-empty string; omit it to accept requests without one",
    );
  }
}

type AuthOutcome =
  | { ok: true; scope: string }
  | { ok: false; reason: "unauthorized" | "forbidden" };

export async function authenticate(
  request: Request,
  options: AuthOptions,
): Promise<AuthOutcome> {
  if (options.token !== undefined) {
    const presented = bearerToken(request);
    if (
      presented === null ||
      !(await timingSafeEqualStrings(presented, options.token))
    ) {
      return { ok: false, reason: "unauthorized" };
    }
  }
  if (!options.authorize) return { ok: true, scope: "" };
  const result = await options.authorize(request);
  if (result === true) return { ok: true, scope: "" };
  if (result === false || result === "unauthorized")
    return { ok: false, reason: "unauthorized" };
  if (result === "forbidden") return { ok: false, reason: "forbidden" };
  return { ok: true, scope: result.scope ?? "" };
}
