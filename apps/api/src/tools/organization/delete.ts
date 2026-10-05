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
import { requireAuth } from "../../core/studio-context";
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
  inputSchema: z.object({
    id: z.string(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    id: z.string(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    // Reject a target org the caller isn't authenticated against (see member-remove.ts).
    if (input.id !== ctx.organization?.id) {
      throw new Error(
        "Organization ID does not match authenticated organization",
      );
    }

    // Merge into existing metadata — organization.update replaces it wholesale.
    const existing = await ctx.boundAuth.organization.get(input.id);
    const existingMetadata = parseOrgMetadata(existing?.metadata);

    // Already archived: skip the write, preserving the original archivedAt.
    if (existingMetadata.archived === true) {
      return {
        success: true,
        id: input.id,
      };
    }

    // Read before archiving, so a failed read fails the delete while nothing
    // has changed yet.
    const reports = await ctx.storage.connections.findById(
      WellKnownOrgMCPId.REPORTS(input.id),
      input.id,
    );

    await ctx.boundAuth.organization.update({
      organizationId: input.id,
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
      where "activeOrganizationId" = ${input.id}
    `.execute(ctx.db);

    const reportsSiteUrl = reports?.metadata?.siteUrl;
    if (typeof reportsSiteUrl === "string") {
      releaseReportsSite({
        siteUrl: reportsSiteUrl,
        orgId: input.id,
        cause: "organization_deleted",
      });
    }

    return {
      success: true,
      id: input.id,
    };
  },
});
