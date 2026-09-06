/**
 * JIRA_* — per-org Jira Cloud integration.
 *
 * One integration per org: site + Basic-auth credentials (API token, vault-
 * encrypted) and one board. Nothing here copies cards: the board is what the
 * integration watches, and the credential is what the server spends on the
 * org's behalf.
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
import type { OrgJiraIntegration } from "@/storage/types";

/** The API token never leaves the server — outputs carry the rest.
 *  `webhookSecret` IS returned: org admins need it to compose the webhook
 *  URL they paste into Jira, and it grants nothing beyond a wake-up call. */
const integrationSchema = z.object({
  id: z.string(),
  siteUrl: z.string(),
  email: z.string(),
  boardId: z.string().nullable(),
  boardName: z.string().nullable(),
  webhookSecret: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

function toOutput(
  integration: OrgJiraIntegration,
): z.infer<typeof integrationSchema> {
  return {
    id: integration.id,
    siteUrl: integration.siteUrl,
    email: integration.email,
    boardId: integration.boardId,
    boardName: integration.boardName,
    webhookSecret: integration.webhookSecret,
    enabled: integration.enabled,
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
    "Get this organization's Jira integration config. Null when Jira is not " +
    "connected. Never returns the API token.",
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
    "current value. Enabling requires a board.",
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
      .describe("Jira board the integration watches (null clears it)"),
    boardName: z
      .string()
      .nullable()
      .optional()
      .describe("Display name of that board"),
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
    const enabled = input.enabled ?? existing?.enabled ?? false;
    // Server-side gate, not just the UI's: an enabled integration with no board
    // has nothing to watch.
    if (enabled && !boardId) {
      throw new Error("Select a board before enabling the Jira integration");
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
      enabled,
      createdBy: existing?.createdBy ?? userId,
    });
    return { integration: toOutput(integration) };
  },
});

export const JIRA_INTEGRATION_DELETE = defineTool({
  name: "JIRA_INTEGRATION_DELETE",
  description: "Disconnect Jira from this organization.",
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
    "which board the integration watches.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    boards: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        type: z.string(),
        projectKey: z.string().optional(),
        projectName: z.string().optional(),
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
    "List a Jira board's columns with the status names each groups, in the " +
    "names the team knows.",
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

export {
  JIRA_AUTOMATION_DELETE,
  JIRA_AUTOMATION_LIST,
  JIRA_AUTOMATION_UPSERT,
} from "./automations";
export {
  JIRA_ATTACHMENT_DOWNLOAD,
  JIRA_COMMENT_ADD,
  JIRA_ISSUE_GET,
  JIRA_ISSUE_TRANSITION,
} from "./run-tools";
