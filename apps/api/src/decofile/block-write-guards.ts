/**
 * What a decofile write is refused for, before it reaches a branch.
 *
 * These checks were inline in the HTTP route, which made them the browser's
 * rules rather than the repository's. An agent writes to the same branch
 * through the same coalescer, so it has to answer the same questions: is this
 * key safe to put on a filesystem, is the value a block at all, and does the
 * key collide with a framework resolver module.
 *
 * A message instead of a throw, so the route can answer 400 with it and a tool
 * can raise it, without either reimplementing the other's refusals.
 */

import {
  assertSafeDecoBlockKey,
  isReservedResolverBlockKey,
} from "@decocms/shared/decofile";
import type { DecofilePatch } from "./commit-coalescer";

/** Why this patch cannot be written, or null when it can. */
export function decofilePatchRefusal(patch: DecofilePatch): string | null {
  for (const key of [
    ...Object.keys(patch.set ?? {}),
    ...(patch.delete ?? []),
  ]) {
    try {
      assertSafeDecoBlockKey(key);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `Block "${key}" must be a JSON object`;
    }
    /** Deletes of resolver-shaped keys stay allowed, so a shadow is repairable. */
    if (isReservedResolverBlockKey(key)) {
      return `Block key "${key}" collides with a framework resolver module and cannot be written`;
    }
  }

  return null;
}
