/**
 * JIRA_* — per-org Jira Cloud integration (pull sync into the task board).
 *
 * One integration per org: site + Basic-auth credentials (API token, vault-
 * encrypted), one project, and a per-tenant status mapping (Jira status name
 * → board status). The jira-sync cron (dbos-jira-sync.ts) pulls mapped issues
 * every ~10 minutes; `_SYNC_RUN` pulls on demand. Nothing is written to Jira.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
  type StudioContext,
} from "@/core/studio-context";
import { JiraClient, normalizeSiteUrl } from "@/jira/client";
import { syncJiraIntegrationSafe } from "@/jira/sync";
import type { OrgJiraIntegration } from "@/storage/types";
import { TaskBoardItemStatusSchema } from "../task-board/schema";

const statusMappingSchema = z
  .record(z.string(), TaskBoardItemStatusSchema)
  .describe(
    "Jira status name → board status. Issues in unmapped Jira statuses are not synced.",
  );

/** The API token never leaves the server — outputs carry the rest.
 *  `webhookSecret` IS returned: org admins need it to compose the webhook
 *  URL they paste into Jira, and it grants nothing beyond triggering a sync. */
const integrationSchema = z.object({
  id: z.string(),
  siteUrl: z.string(),
  email: z.string(),
  boardId: z.string().nullable(),
  boardName: z.string().nullable(),
  statusMapping: statusMappingSchema,
  jqlFilter: z.string().nullable(),
  autoDelegate: z.boolean(),
  webhookSecret: z.string(),
  enabled: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  createdAt: z.string(),
});

const syncResultSchema = z.union([
  z.object({
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    skipped: z.number(),
  }),
  z.object({ error: z.string() }),
]);

function toOutput(
  integration: OrgJiraIntegration,
): z.infer<typeof integrationSchema> {
  return {
    id: integration.id,
    siteUrl: integration.siteUrl,
    email: integration.email,
    boardId: integration.boardId,
    boardName: integration.boardName,
    statusMapping: integration.statusMapping,
    jqlFilter: integration.jqlFilter,
    autoDelegate: integration.autoDelegate,
    webhookSecret: integration.webhookSecret,
    enabled: integration.enabled,
    lastSyncedAt: integration.lastSyncedAt,
    lastSyncError: integration.lastSyncError,
    createdAt: integration.createdAt,
  };
}

async function requireIntegration(
  ctx: StudioContext,
  organizationId: string,
): Promise<OrgJiraIntegration> {
  const integration =
    await ctx.storage.jiraIntegrations.getByOrg(organizationId);
  if (!integration) {
    throw new Error(
      "Jira is not connected — save credentials with JIRA_INTEGRATION_UPSERT first",
    );
  }
  return integration;
}

export const JIRA_INTEGRATION_GET = defineTool({
  name: "JIRA_INTEGRATION_GET",
  description:
    "Get this organization's Jira integration config and last sync status. " +
    "Null when Jira is not connected. Never returns the API token.",
  inputSchema: z.object({}),
  outputSchema: z.object({ integration: integrationSchema.nullable() }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const integration = await ctx.storage.jiraIntegrations.getByOrg(
      organization.id,
    );
    return { integration: integration ? toOutput(integration) : null };
  },
});

export const JIRA_INTEGRATION_UPSERT = defineTool({
  name: "JIRA_INTEGRATION_UPSERT",
  description:
    "Connect or update this organization's Jira integration. Credentials " +
    "(siteUrl + email + apiToken) are required on first connect and are " +
    "validated against Jira before saving; omitted fields keep their " +
    "current value. Enable with a project and status mapping to start the " +
    "~10-minute pull sync.",
  inputSchema: z.object({
    siteUrl: z
      .string()
      .optional()
      .describe("Jira site, e.g. yourcompany.atlassian.net"),
    email: z.string().optional().describe("Atlassian account email"),
    apiToken: z.string().optional().describe("Jira API token for that account"),
    boardId: z
      .string()
      .nullable()
      .optional()
      .describe("Jira board to mirror (null clears it)"),
    boardName: z
      .string()
      .nullable()
      .optional()
      .describe("Display name of that board"),
    statusMapping: statusMappingSchema.optional(),
    jqlFilter: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Extra JQL ANDed into the pull, e.g. to match the Jira board's saved filter (null clears it)",
      ),
    autoDelegate: z
      .boolean()
      .optional()
      .describe(
        "Assign the Super Agent when an issue lands in a To Do-mapped column",
      ),
    enabled: z.boolean().optional(),
  }),
  outputSchema: z.object({ integration: integrationSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

    const existing = await ctx.storage.jiraIntegrations.getByOrg(
      organization.id,
    );
    const siteUrl = input.siteUrl ?? existing?.siteUrl;
    const email = input.email ?? existing?.email;
    const apiToken = input.apiToken ?? existing?.apiToken;
    if (!siteUrl || !email || !apiToken) {
      throw new Error(
        "siteUrl, email and apiToken are required to connect Jira",
      );
    }
    const normalizedSiteUrl = normalizeSiteUrl(siteUrl);

    const credentialsChanged =
      !existing ||
      normalizedSiteUrl !== existing.siteUrl ||
      email !== existing.email ||
      input.apiToken !== undefined;
    if (credentialsChanged) {
      try {
        await new JiraClient(normalizedSiteUrl, email, apiToken).myself();
      } catch (err) {
        throw new Error(
          `Could not authenticate with Jira: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const boardId =
      input.boardId !== undefined ? input.boardId : (existing?.boardId ?? null);
    const statusMapping = input.statusMapping ?? existing?.statusMapping ?? {};
    const enabled = input.enabled ?? existing?.enabled ?? false;
    // Server-side gate, not just the UI's: enabling without a board or a
    // mapping makes every cron tick throw and record the same error for as long
    // as it stays that way, with nothing to self-heal it. Reachable from the
    // board-change path too, which clears the mapping while `enabled` stays on.
    if (enabled && (!boardId || Object.keys(statusMapping).length === 0)) {
      throw new Error(
        "Select a board and map at least one column before enabling the Jira sync",
      );
    }

    const integration = await ctx.storage.jiraIntegrations.upsert({
      organizationId: organization.id,
      siteUrl: normalizedSiteUrl,
      email,
      apiToken,
      boardId,
      boardName:
        input.boardName !== undefined
          ? input.boardName
          : (existing?.boardName ?? null),
      statusMapping,
      jqlFilter:
        input.jqlFilter !== undefined
          ? input.jqlFilter
          : (existing?.jqlFilter ?? null),
      autoDelegate: input.autoDelegate ?? existing?.autoDelegate ?? false,
      enabled,
      createdBy: existing?.createdBy ?? userId,
    });
    return { integration: toOutput(integration) };
  },
});

export const JIRA_INTEGRATION_DELETE = defineTool({
  name: "JIRA_INTEGRATION_DELETE",
  description:
    "Disconnect Jira from this organization. Already-synced board cards are " +
    "kept; they just stop updating.",
  inputSchema: z.object({}),
  outputSchema: z.object({ deleted: z.boolean() }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const deleted = await ctx.storage.jiraIntegrations.delete(organization.id);
    return { deleted };
  },
});

export const JIRA_BOARDS_LIST = defineTool({
  name: "JIRA_BOARDS_LIST",
  description:
    "List the Jira boards visible to the connected credentials — for picking " +
    "which board to mirror.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    boards: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        type: z.string(),
        projectKey: z.string().optional(),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const integration = await requireIntegration(ctx, organization.id);
    const client = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );
    return { boards: await client.listBoards() };
  },
});

export const JIRA_BOARD_COLUMNS_LIST = defineTool({
  name: "JIRA_BOARD_COLUMNS_LIST",
  description:
    "List a Jira board's columns with the status names each groups — the " +
    "left-hand side of the status mapping, in the names the team knows.",
  inputSchema: z.object({ boardId: z.string() }),
  outputSchema: z.object({
    columns: z.array(
      z.object({ name: z.string(), statuses: z.array(z.string()) }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const integration = await requireIntegration(ctx, organization.id);
    const client = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );
    return { columns: await client.getBoardColumns(input.boardId) };
  },
});

export const JIRA_SYNC_RUN = defineTool({
  name: "JIRA_SYNC_RUN",
  description:
    "Pull from Jira into the task board right now (the 'I just changed " +
    "something in Jira' button). Returns created/updated/unchanged/skipped " +
    "counts, or the error that was recorded on the integration.",
  inputSchema: z.object({}),
  outputSchema: z.object({ result: syncResultSchema }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const integration = await requireIntegration(ctx, organization.id);
    if (!integration.enabled) {
      throw new Error(
        "The Jira sync is disabled — enable it with JIRA_INTEGRATION_UPSERT before running",
      );
    }
    const result = await syncJiraIntegrationSafe(ctx, integration);
    return { result };
  },
});
