/**
 * Admin thread analytics — every thread (chats, automations, task runs) across
 * orgs: a live feed, usage and spend, and errors.
 *
 * Admin-only even for the caller's own org: a plain member may only list their
 * own threads (`COLLECTION_THREADS_LIST`), so a per-user spend table or a live
 * feed of teammates' chats would widen that. Scope (`org`, `"all"`, range) goes
 * through the task board's `resolveScope`, so the gate and audit line match.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { isAdminOrgId, isTaskBoardAdminCtx } from "@/core/task-board-admin";
import {
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import { THREAD_KINDS } from "@/storage/thread-analytics";
import { defineAnalyticsTool, resolveScope } from "../task-board/analytics";

async function requireThreadAdmin(ctx: StudioContext): Promise<void> {
  const organization = requireOrganization(ctx);
  if (!isAdminOrgId(organization.id) || !(await isTaskBoardAdminCtx(ctx))) {
    throw new Error("Thread analytics is only available in an admin org");
  }
}

export const THREAD_ANALYTICS_USAGE = defineAnalyticsTool(
  "THREAD_ANALYTICS_USAGE",
  "Thread Usage",
  'Token and USD usage across chats, automations and task runs: totals, spend per day by kind, top orgs and users over the last 24h/7d/30d, and spend by org, user, agent and thread. Admin orgs only; org: "all" for every tenant.',
  async (ctx, query) => {
    await requireThreadAdmin(ctx);
    return ctx.storage.threadAnalytics.usage(query);
  },
);

export const THREAD_ANALYTICS_ERRORS = defineAnalyticsTool(
  "THREAD_ANALYTICS_ERRORS",
  "Thread Errors",
  'Failed threads across chats, automations and task runs: counts, failures per day by kind, failure kinds, errors by org, a live error feed and error signatures. Admin orgs only; org: "all" for every tenant.',
  async (ctx, query) => {
    await requireThreadAdmin(ctx);
    return ctx.storage.threadAnalytics.errors(query);
  },
);

export const THREAD_ANALYTICS_LIVE = defineTool({
  name: "THREAD_ANALYTICS_LIVE",
  description:
    'The most recently active threads (chats, automations, task runs) with status, owner, agent and spend, plus how many are running, waiting on a human, and failed in the last hour. Admin orgs only; org: "all" for every tenant.',
  annotations: {
    title: "Live Threads",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    org: z
      .string()
      .optional()
      .describe(
        'Org slug or id. Omit for the current org; "all" for every tenant.',
      ),
    status: z
      .enum(["in_progress", "requires_action", "failed", "completed"])
      .optional(),
    kind: z.enum(THREAD_KINDS).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  outputSchema: z.object({
    org: z.string(),
    counts: z.object({
      running: z.number(),
      waiting: z.number(),
      failedLastHour: z.number(),
    }),
    threads: z.array(
      z.object({
        id: z.string(),
        orgId: z.string(),
        orgSlug: z.string(),
        title: z.string(),
        status: z.string(),
        kind: z.enum(THREAD_KINDS),
        failureKind: z.string().nullable(),
        failureReason: z.string().nullable(),
        lastError: z.string().nullable(),
        harnessId: z.string().nullable(),
        agent: z.string(),
        userName: z.string().nullable(),
        userEmail: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
        usd: z.number().nullable(),
        tokens: z.number().nullable(),
      }),
    ),
  }),
  modelSummary: (r) =>
    `${r.org}: ${r.counts.running} running, ${r.counts.waiting} waiting, ${r.counts.failedLastHour} failed in the last hour; ${r.threads.length} recent threads`,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    await requireThreadAdmin(ctx);
    const { query, org } = await resolveScope(
      { org: input.org },
      ctx,
      "THREAD_ANALYTICS_LIVE",
    );
    const live = await ctx.storage.threadAnalytics.live({
      orgIds: query.orgIds,
      status: input.status,
      kind: input.kind,
      limit: input.limit,
    });
    return { org, ...live };
  },
});

export const THREAD_ANALYTICS_ORG_LIST = defineTool({
  name: "THREAD_ANALYTICS_ORG_LIST",
  description:
    "Whether the caller may read every org's threads, and if so the orgs that have any. Non-admins get an empty list.",
  annotations: {
    title: "List Thread Analytics Orgs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    isAdmin: z.boolean(),
    orgs: z.array(
      z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    if (!isAdminOrgId(organization.id) || !(await isTaskBoardAdminCtx(ctx))) {
      return { isAdmin: false, orgs: [] };
    }
    return {
      isAdmin: true,
      orgs: await ctx.storage.threadAnalytics.orgsWithThreads(),
    };
  },
});
