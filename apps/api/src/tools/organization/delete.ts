/**
 * ORGANIZATION_DELETE Tool
 *
 * Soft-deletes an organization by flagging it as archived in metadata.
 * Archived organizations are invisible to all API and UI surfaces.
 */

import { parseOrgMetadata } from "@decocms/shared/organization/org-archived";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { sql } from "kysely";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { releaseReportsSite } from "../reports/release";

export const ORGANIZATION_DELETE = defineTool({
  name: "ORGANIZATION_DELETE",
  description: "Archive an organization (soft delete).",
  annotations: {
    title: "Delete Organization",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),

  outputSchema: z.object({
    success: z.boolean(),
    id: z.string(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    // The target org is the one resolved from the URL path; the input carries
    // no id, so there is nothing to compare and nothing to spoof.
    const org = requireOrganization(ctx);

    // Merge into existing metadata — organization.update replaces it wholesale.
    const existing = await ctx.boundAuth.organization.get(org.id);
    const existingMetadata = parseOrgMetadata(existing?.metadata);

    // Already archived: skip the write, preserving the original archivedAt.
    if (existingMetadata.archived === true) {
      return {
        success: true,
        id: org.id,
      };
    }

    // Read before archiving, so a failed read fails the delete while nothing
    // has changed yet.
    const reports = await ctx.storage.connections.findById(
      WellKnownOrgMCPId.REPORTS(org.id),
      org.id,
    );

    await ctx.boundAuth.organization.update({
      organizationId: org.id,
      data: {
        metadata: {
          ...existingMetadata,
          archived: true,
          archivedAt: new Date().toISOString(),
        },
      },
    });

    // Raw SQL: Better Auth owns `session`, not in the Kysely types.
    await sql`
      update session set "activeOrganizationId" = null
      where "activeOrganizationId" = ${org.id}
    `.execute(ctx.db);

    const reportsSiteUrl = reports?.metadata?.siteUrl;
    if (typeof reportsSiteUrl === "string") {
      releaseReportsSite({
        siteUrl: reportsSiteUrl,
        orgId: org.id,
        cause: "organization_deleted",
      });
    }

    return {
      success: true,
      id: org.id,
    };
  },
});
