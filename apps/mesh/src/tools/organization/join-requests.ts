/**
 * Organization join-request tools (admin side of the request-to-join flow).
 *
 * The request rows are created by the domain-gated `/api/auth/custom/
 * domain-request-join` route; these tools let admins list and decide them.
 * They're org-agnostic on purpose — the generic membership-request mechanism.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { isAlreadyMemberError } from "../../auth/is-already-member-error";
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

    // Claim the decision atomically BEFORE adding the member. If a concurrent
    // deny won, decide() returns null and we add nothing — a denied request
    // must never leave the user as a member. (If addMember then fails, the
    // request is already approved + has no pending row, so org-access-status
    // shows can-request again and the user can simply re-request.)
    const actorId = getUserId(ctx);
    const decided = await ctx.storage.organizationJoinRequests.decide(
      request.id,
      "approved",
      actorId ?? request.userId,
    );
    if (!decided) {
      // Another admin already decided this request (approve or deny) — respect
      // it. If it was a concurrent approve, that caller added the member.
      return { success: true };
    }

    // We won the transition; add the member (idempotent if they joined another
    // way in the meantime).
    try {
      await ctx.boundAuth.organization.addMember({
        organizationId: org.id,
        userId: request.userId,
        role: ["user"],
      });
    } catch (error) {
      if (!isAlreadyMemberError(error)) {
        throw error;
      }
    }

    if (actorId) {
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
