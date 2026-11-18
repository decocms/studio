/**
 * Shareable invite links (admin side).
 *
 * Anyone holding a link can join the org until it expires or is revoked; the
 * redeem side lives in `/api/auth/custom/invite-link/:token` because the
 * person redeeming is not a member yet.
 */

import { z } from "zod";
import { canAssignRole } from "@decocms/shared/auth/roles";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import {
  generateInviteLinkToken,
  hashInviteLinkToken,
  INVITE_LINK_TTL_MS,
  isSafeInviteRedirect,
} from "../../auth/invite-link-token";
import { posthog } from "../../posthog";

const linkSchema = z.object({
  id: z.string(),
  role: z.string(),
  redirectPath: z.string().nullable(),
  createdBy: z.string().nullable(),
  expiresAt: z.string().datetime(),
  useCount: z.number().int(),
  createdAt: z.string().datetime(),
});

export const ORGANIZATION_INVITE_LINK_CREATE = defineTool({
  name: "ORGANIZATION_INVITE_LINK_CREATE",
  description:
    "Create a link that lets anyone who opens it join the organization for the next 24 hours, landing on redirectPath.",
  annotations: {
    title: "Create Invite Link",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    role: z
      .string()
      .min(1)
      .max(200)
      .default("user")
      .describe("Role granted to whoever joins through the link"),
    redirectPath: z
      .string()
      .max(2048)
      .optional()
      .describe(
        "Relative path inside the organization to open after joining, e.g. /my-org/apps/x",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    /** Relative path; the client prefixes its own origin. */
    path: z.string(),
    expiresAt: z.string().datetime(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const userId = getUserId(ctx);

    const orgRow = await ctx.db
      .selectFrom("organization")
      .select(["slug"])
      .where("id", "=", org.id)
      .executeTakeFirstOrThrow();

    // A link never grants owner, and never more than the caller could assign.
    const caller = await ctx.db
      .selectFrom("member")
      .select(["role"])
      .where("userId", "=", userId ?? "")
      .where("organizationId", "=", org.id)
      .executeTakeFirst();
    if (input.role === "owner" || !canAssignRole(caller?.role, input.role)) {
      throw new Error(`Insufficient privileges to grant role "${input.role}"`);
    }

    const redirectPath = input.redirectPath ?? `/${orgRow.slug}`;
    if (!isSafeInviteRedirect(redirectPath, orgRow.slug)) {
      throw new Error("redirectPath must be a path inside this organization");
    }

    const token = generateInviteLinkToken();
    const link = await ctx.storage.organizationInviteLinks.create({
      organizationId: org.id,
      tokenHash: await hashInviteLinkToken(token),
      role: input.role,
      redirectPath,
      createdBy: userId ?? null,
      expiresAt: new Date(Date.now() + INVITE_LINK_TTL_MS),
    });

    if (userId) {
      posthog.capture({
        distinctId: userId,
        event: "organization_invite_link_created",
        groups: { organization: org.id },
        properties: { organization_id: org.id, role: input.role },
      });
    }

    return {
      id: link.id,
      path: `/invite/${token}`,
      expiresAt: link.expiresAt.toISOString(),
    };
  },
});

export const ORGANIZATION_INVITE_LINK_LIST = defineTool({
  name: "ORGANIZATION_INVITE_LINK_LIST",
  description:
    "List the organization's active (unexpired, unrevoked) invite links.",
  annotations: {
    title: "List Invite Links",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ links: z.array(linkSchema) }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const links = await ctx.storage.organizationInviteLinks.listActive(org.id);
    return {
      links: links.map((link) => ({
        id: link.id,
        role: link.role,
        redirectPath: link.redirectPath,
        createdBy: link.createdBy,
        expiresAt: link.expiresAt.toISOString(),
        useCount: link.useCount,
        createdAt: link.createdAt.toISOString(),
      })),
    };
  },
});

export const ORGANIZATION_INVITE_LINK_REVOKE = defineTool({
  name: "ORGANIZATION_INVITE_LINK_REVOKE",
  description:
    "Revoke an invite link so nobody else can join through it. Members who already joined stay.",
  annotations: {
    title: "Revoke Invite Link",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1) }),
  outputSchema: z.object({ revoked: z.boolean() }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const revoked = await ctx.storage.organizationInviteLinks.revoke(
      input.id,
      org.id,
    );
    return { revoked };
  },
});
