/**
 * Organization join-request tools (admin side of the request-to-join flow).
 *
 * The request rows are created by the domain-gated `/api/auth/custom/
 * domain-request-join` route; these tools let admins list and decide them.
 * They're org-agnostic on purpose — the generic membership-request mechanism.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { posthog } from "../../posthog";

const requestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  createdAt: z.string(),
  user: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const ORGANIZATION_JOIN_REQUEST_LIST = defineTool({
  name: "ORGANIZATION_JOIN_REQUEST_LIST",
  description: "List pending requests to join the organization.",
  annotations: {
    title: "List Join Requests",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ requests: z.array(requestSchema) }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const requests =
      await ctx.storage.organizationJoinRequests.listPendingWithUser(org.id);

    return {
      requests: requests.map((r) => ({
        id: r.id,
        userId: r.userId,
        status: r.status,
        createdAt: new Date(r.createdAt).toISOString(),
        user: r.user,
      })),
    };
  },
});

export const ORGANIZATION_JOIN_REQUEST_APPROVE = defineTool({
  name: "ORGANIZATION_JOIN_REQUEST_APPROVE",
  description: "Approve a pending join request, adding the user as a member.",
  annotations: {
    title: "Approve Join Request",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ requestId: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const request = await ctx.storage.organizationJoinRequests.getById(
      input.requestId,
    );
    if (!request || request.organizationId !== org.id) {
      throw new Error("Join request not found");
    }
    if (request.status !== "pending") {
      throw new Error("Join request has already been decided");
    }

    // Add the member. If they already joined some other way, treat as success.
    try {
      await ctx.boundAuth.organization.addMember({
        organizationId: org.id,
        userId: request.userId,
        role: ["user"],
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : "";
      if (!msg.includes("already a member")) {
        throw error;
      }
    }

    const actorId = getUserId(ctx);
    const decided = await ctx.storage.organizationJoinRequests.decide(
      request.id,
      "approved",
      actorId ?? request.userId,
    );

    // Only capture if this call won the transition (another admin may have
    // raced). Membership is added regardless via the idempotent addMember.
    if (decided && actorId) {
      posthog.capture({
        distinctId: actorId,
        event: "organization_join_request_approved",
        groups: { organization: org.id },
        properties: { organization_id: org.id, user_id: request.userId },
      });
    }

    return { success: true };
  },
});

export const ORGANIZATION_JOIN_REQUEST_DENY = defineTool({
  name: "ORGANIZATION_JOIN_REQUEST_DENY",
  description: "Deny a pending join request.",
  annotations: {
    title: "Deny Join Request",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ requestId: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const request = await ctx.storage.organizationJoinRequests.getById(
      input.requestId,
    );
    if (!request || request.organizationId !== org.id) {
      throw new Error("Join request not found");
    }
    if (request.status !== "pending") {
      throw new Error("Join request has already been decided");
    }

    const actorId = getUserId(ctx);
    const decided = await ctx.storage.organizationJoinRequests.decide(
      request.id,
      "denied",
      actorId ?? request.userId,
    );

    if (decided && actorId) {
      posthog.capture({
        distinctId: actorId,
        event: "organization_join_request_denied",
        groups: { organization: org.id },
        properties: { organization_id: org.id, user_id: request.userId },
      });
    }

    return { success: true };
  },
});
