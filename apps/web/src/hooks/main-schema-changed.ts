/**
 * When main changes during an editor session (a v8 migration merged while a
 * v7 editor is open, or main back on v7 under a v8 one), the server and the
 * page's once-per-session answer for main disagree. The editor's requests
 * say which answer they act on (`MAIN_SCHEMA_HEADER`); the server refuses a
 * mismatch with 409 `main_schema_changed`, and the editor forgets main's
 * answer and decides again (`resetMainSchemaAnswer`), showing the loading
 * state first: never the other generation's shape, never a direct swap.
 *
 * Kept apart from `use-main-schema-v8` (a hook over the project context) so
 * plain request helpers can use it anywhere.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  MAIN_SCHEMA_CHANGED,
  MAIN_SCHEMA_HEADER,
} from "@decocms/shared/blocks-major";
import { KEYS } from "@/lib/query-keys";

/**
 * The header that tells the server which main answer a request acts on
 * (`MAIN_SCHEMA_HEADER`): on a mismatch the server answers 409
 * `main_schema_changed` instead of serving the other generation's shape.
 */
export function mainSchemaHeaders(answer: "v8" | "v7"): Record<string, string> {
  return { [MAIN_SCHEMA_HEADER]: answer };
}

/** Thrown for the server's 409 `main_schema_changed`. */
export class MainSchemaChangedError extends Error {
  readonly status = 409;
  constructor() {
    super("main's schema changed");
  }
}

/** Whether a Studio response is the 409 `main_schema_changed` answer. */
export async function isMainSchemaChangedResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === MAIN_SCHEMA_CHANGED;
}

/**
 * Main changed during the session (the server said `main_schema_changed`):
 * forget main's answer and Studio's GitHub backend probe for the project, so
 * the editor goes back to waiting (pending) and decides again on main's new
 * answer. Never a direct swap from one editor to the other.
 */
export function resetMainSchemaAnswer(
  queryClient: QueryClient,
  orgSlug: string,
  virtualMcpId: string,
): void {
  void queryClient.resetQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[1] !== orgSlug || key[2] !== virtualMcpId) return false;
      return (
        key[0] === KEYS.mainSchemaV8(orgSlug, virtualMcpId)[0] ||
        (key[0] === KEYS.contentBackend()[0] && key[4] === "github")
      );
    },
  });
}
