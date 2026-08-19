/**
 * Org-wide env for task-board runs, read from one vault secret.
 *
 * A board run is dispatched by the board, not by a person opening an agent, so
 * it has no virtual MCP whose `metadata.runtime.env` it could inherit — its
 * `virtual_mcp_id` is the synthetic Decopilot id, which has no row. Its pod
 * therefore boots with nothing but the model credential.
 *
 * So: an org-scoped secret named `TASK_RUN_ENV` holding a `.env` blob. No new
 * column, no new tool, no new UI — Settings → Secrets already creates and
 * rotates it, and the value stays encrypted in the vault instead of riding in
 * the org-settings payload every member reads on shell load.
 *
 * ⚠️ SECURITY: everything here carries secret VALUES. Never log a resolved map,
 * and never put one in an error message.
 */

import { parseDotenv } from "@decocms/shared/parse-dotenv";
import type { StudioContext } from "@/core/studio-context";

/** The org-scoped secret a run's env is read from. */
const TASK_RUN_ENV_SECRET = "TASK_RUN_ENV";

/**
 * The org's task-run env, or `{}` when the secret is absent.
 *
 * Best-effort: a missing secret is the normal case, and an unparseable one must
 * not fail a run that would otherwise work — it is logged (key names and the
 * parse error only) and skipped.
 */
export async function resolveOrgRunEnv(
  ctx: StudioContext,
): Promise<Record<string, string>> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) return {};
  try {
    const { value } = await ctx.storage.secrets.resolveByName({
      organizationId,
      scope: { kind: "organization" },
      name: TASK_RUN_ENV_SECRET,
    });
    return parseDotenv(value);
  } catch (err) {
    // Absent is the default state, so it isn't worth a line in the log.
    if ((err as { name?: string })?.name !== "SecretNotFoundError") {
      console.warn(
        `[org-run-env] ignoring the ${TASK_RUN_ENV_SECRET} secret: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {};
  }
}

/**
 * The env one run boots with. The model credential WINS over the org's env: a
 * member who can write secrets must not be able to repoint every board run at
 * their own `ANTHROPIC_BASE_URL` and read the traffic.
 *
 * Pure, so the precedence is unit-tested.
 */
export function mergeRunEnv(
  orgEnv: Record<string, string>,
  modelEnv: Record<string, string | null>,
): Record<string, string | null> {
  return { ...orgEnv, ...modelEnv };
}
