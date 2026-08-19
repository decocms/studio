/**
 * Org-wide env for sandbox-hosted runs.
 *
 * A task-board run is dispatched by the board, not by a person opening an
 * agent, so it has no virtual MCP whose `metadata.runtime.env` it could inherit
 * — its `virtual_mcp_id` is the synthetic Decopilot id, which has no row. Its
 * pod therefore booted with nothing but the model credential, and an org whose
 * tests or build need `SOME_API_KEY` had no way to hand it over. This is that
 * way: `organization_settings.task_board_env`, resolved per run.
 *
 * ⚠️ SECURITY: everything here carries secret VALUES. Never log a resolved map,
 * and never put one in an error message.
 */

import { TaskBoardEnvEntrySchema } from "@decocms/shared/organization/schema";
import type { StudioContext } from "@/core/studio-context";
import { resolveEnvEntries } from "@/tools/sandbox/resolve-env";

/**
 * The org's task-board env, resolved against the credential vault.
 *
 * Best-effort by design: a settings read that fails, or a secret that no longer
 * resolves, must not fail a run that would otherwise work — the run just doesn't
 * see that key, same as `resolveAndPushEnv` on an agent's own env.
 *
 * The jsonb column is untrusted (older rows, hand-edited settings), so each
 * entry is validated on the way out and a malformed one is dropped rather than
 * poisoning the whole map.
 */
export async function resolveOrgRunEnv(
  ctx: StudioContext,
  userId: string,
): Promise<Record<string, string>> {
  const orgId = ctx.organization?.id;
  if (!orgId) return {};
  try {
    const settings = await ctx.storage.organizationSettings.get(orgId);
    const stored = settings?.task_board_env;
    if (!Array.isArray(stored) || stored.length === 0) return {};
    const entries = stored.flatMap((entry) => {
      const parsed = TaskBoardEnvEntrySchema.safeParse(entry);
      return parsed.success
        ? [{ ...parsed.data, kind: "secret" as const }]
        : [];
    });
    if (entries.length === 0) return {};
    return await resolveEnvEntries({ ctx, orgId, userId, entries });
  } catch (err) {
    console.warn(
      `[org-run-env] skipping the org env for this run: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

/**
 * The env one run boots with. The model credential WINS over the org's env: a
 * member who can edit org settings must not be able to repoint every board run
 * at their own `ANTHROPIC_BASE_URL` and read the traffic.
 *
 * Pure, so the precedence is unit-tested.
 */
export function mergeRunEnv(
  orgEnv: Record<string, string>,
  modelEnv: Record<string, string | null>,
): Record<string, string | null> {
  return { ...orgEnv, ...modelEnv };
}
