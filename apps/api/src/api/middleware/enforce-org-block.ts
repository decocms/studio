/**
 * Refuses control-plane writes to an organization a deployment admin has
 * blocked (see `core/org-notice-gate`). Mounted on the org-scoped router right
 * after `resolveOrgFromPath`, so `ctx.organization` is already resolved.
 *
 * Reads (and the data-plane paths listed in the gate) return before any lookup,
 * so the cost on the hot path is a method comparison and one array scan of the
 * first path segment. Builtin tool calls are left to the gate inside
 * `defineTool`, which can decide per tool name.
 */

import type { MiddlewareHandler } from "hono";
import {
  isBlockableOrgRequest,
  isOrgBlocked,
} from "../../core/org-notice-gate";
import type { Env } from "../hono-env";

export const enforceOrgBlock: MiddlewareHandler<Env> = async (c, next) => {
  if (!isBlockableOrgRequest(c.req.method, c.req.path)) {
    return next();
  }

  const ctx = c.get("studioContext");
  const organizationId = ctx?.organization?.id;
  if (!organizationId || !ctx?.db) {
    return next();
  }

  if (await isOrgBlocked(ctx.db, organizationId)) {
    return c.json(
      {
        error:
          "This organization is blocked. Resolve the outstanding notice to restore access.",
        code: "org_blocked",
      },
      403,
    );
  }

  return next();
};
