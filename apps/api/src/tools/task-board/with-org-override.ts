/**
 * Let an admin-org member aim a task-board tool at another org from chat.
 *
 * A chat tool call has no `/api/:org` path segment to rebind from, so the
 * target org has to be an explicit input. Wrapping registration is how that
 * happens once instead of in thirty handlers — and it is applied to a named
 * list, not to `CORE_TOOLS`: a global `org` param bloats every schema the model
 * reads and widens far more surface than asked for.
 *
 * Permission still comes from the caller's own org (`ctx.access` is carried
 * over untouched); only the data scope moves. The override builds a fresh
 * context per invocation, so a later tool call in the same turn never inherits
 * it.
 */

import { z } from "zod";
import {
  auditTaskBoardAdminAction,
  isTaskBoardAdminCtx,
} from "@/core/task-board-admin";
import type { StudioContext } from "@/core/studio-context";
import { buildOrgContext } from "./org-context";

const OrgOverrideShape = {
  org: z
    .string()
    .optional()
    .describe(
      "Org slug or id to read instead of the current one. Requires membership of an admin org; omit for the current org.",
    ),
};

/**
 * Appended to the wrapped tool's OWN description.
 *
 * The parameter alone did not land: a model reading "List all task board items
 * for the organization" concludes it cannot leave this org, and answers from
 * that belief without ever reaching an optional field further down the schema.
 * Told outright that another org was meant, it still refused — the capability
 * has to be in the sentence the model reads first.
 *
 * Naming the discovery tool is the other half: the model has no way to know
 * which orgs exist, or that it may name one, and guessing a slug that turns out
 * to be refused teaches it the wrong lesson.
 */
const ORG_OVERRIDE_HINT =
  " Pass `org` to read ANOTHER organization's board instead of the current " +
  "one — call TASK_BOARD_ADMIN_ORG_LIST first for the organizations you may " +
  "name (an empty list means none, and `org` will be refused).";

interface WrappableTool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: never, ctx: StudioContext) => Promise<unknown>;
}

type LooseTool = {
  name: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute: (input: unknown, ctx: StudioContext) => Promise<unknown>;
};

async function scopedTo(
  ctx: StudioContext,
  ref: string,
  toolName: string,
): Promise<StudioContext> {
  if (!(await isTaskBoardAdminCtx(ctx))) {
    throw new Error(
      "Not allowed to act on another organization (the `org` parameter needs an admin org)",
    );
  }
  const target = await ctx.storage.taskBoardAnalytics.resolveOrgRef(ref);
  if (!target) throw new Error(`Organization not found: ${ref}`);
  if (!ctx.db) throw new Error("No database on context");

  const scoped = await buildOrgContext(ctx.db, target.id);
  if (!scoped) throw new Error(`Organization not found: ${ref}`);

  auditTaskBoardAdminAction({
    action: "tool_org_override",
    actorUserId: ctx.auth?.user?.id,
    actorOrgId: ctx.organization?.id,
    targetOrgId: target.id,
    tool: toolName,
  });

  scoped.auth = ctx.auth;
  scoped.boundAuth = ctx.boundAuth;
  scoped.access = ctx.access;
  return scoped;
}

/**
 * The returned tool keeps its declared type: `org` is advertised on the wire
 * schema the model reads, but the generated TS contract stays the tool's own —
 * nothing in app code passes `org`.
 */
export function withOrgOverride<T extends WrappableTool>(tool: T): T {
  const inner = tool as unknown as LooseTool;
  return {
    ...tool,
    description: `${tool.description}${ORG_OVERRIDE_HINT}`,
    inputSchema: inner.inputSchema.extend(OrgOverrideShape),
    execute: async (input: unknown, ctx: StudioContext) => {
      const { org, ...rest } = (input ?? {}) as { org?: string };
      if (!org) return inner.execute(input, ctx);
      return inner.execute(rest, await scopedTo(ctx, org, tool.name));
    },
  } as unknown as T;
}
