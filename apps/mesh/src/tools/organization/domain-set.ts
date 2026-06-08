/**
 * ORGANIZATION_DOMAIN_SET Tool
 *
 * Claim an email domain for an organization. Requires that the caller's
 * email matches the domain and is verified.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { GENERIC_EMAIL_DOMAINS } from "../../auth";

const DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const ORGANIZATION_DOMAIN_SET = defineTool({
  name: "ORGANIZATION_DOMAIN_SET",
  description:
    "Claim an email domain for an organization. The caller's verified email must match the domain.",
  annotations: {
    title: "Set Organization Domain",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    domain: z
      .string()
      .min(1)
      .max(255)
      .describe("Email domain to claim (e.g. 'acme.com')"),
    autoJoinEnabled: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether users with matching email domain can auto-join"),
  }),
  outputSchema: z.object({
    domain: z.string(),
    autoJoinEnabled: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const domain = input.domain.toLowerCase().trim();

    if (!DOMAIN_REGEX.test(domain)) {
      throw new Error(
        `Invalid domain format: "${domain}". Must be a valid domain like "acme.com"`,
      );
    }

    if (GENERIC_EMAIL_DOMAINS.has(domain)) {
      throw new Error(
        `Cannot claim generic email domain "${domain}". Only corporate domains are allowed.`,
      );
    }

    // Require verified email matching the claimed domain
    const userEmail = ctx.auth.user?.email;
    if (!userEmail) {
      throw new Error("User email is required to claim a domain.");
    }
    if (!ctx.auth.user?.emailVerified) {
      throw new Error("Email must be verified before claiming a domain.");
    }
    const userDomain = userEmail.split("@")[1]?.toLowerCase();
    if (userDomain !== domain) {
      throw new Error(
        `You can only claim your own email domain ("${userDomain}"), not "${domain}".`,
      );
    }

    // Prevent overwriting an existing different domain claim.
    // Admins must clear the old domain first via ORGANIZATION_DOMAIN_CLEAR.
    const existing = await ctx.storage.organizationDomains.getByOrganizationId(
      org.id,
    );
    if (existing && existing.domain !== domain) {
      throw new Error(
        `This organization already claims "${existing.domain}". Clear it first before claiming a new domain.`,
      );
    }

    const result = await ctx.storage.organizationDomains.setDomain(
      org.id,
      domain,
      input.autoJoinEnabled,
    );

    return {
      domain: result.domain,
      autoJoinEnabled: result.autoJoinEnabled,
    };
  },
});

export const ORGANIZATION_DOMAIN_UPDATE = defineTool({
  name: "ORGANIZATION_DOMAIN_UPDATE",
  description:
    "Update auto-join setting for the organization's already-claimed domain.",
  annotations: {
    title: "Update Organization Domain Settings",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    autoJoinEnabled: z
      .boolean()
      .describe("Whether users with matching email domain can auto-join"),
  }),
  outputSchema: z.object({
    domain: z.string(),
    autoJoinEnabled: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const existing = await ctx.storage.organizationDomains.getByOrganizationId(
      org.id,
    );
    if (!existing) {
      throw new Error("No domain claimed for this organization.");
    }

    const result = await ctx.storage.organizationDomains.updateAutoJoin(
      org.id,
      input.autoJoinEnabled,
    );

    return {
      domain: result.domain,
      autoJoinEnabled: result.autoJoinEnabled,
    };
  },
});

export const ORGANIZATION_DOMAIN_CLEAR = defineTool({
  name: "ORGANIZATION_DOMAIN_CLEAR",
  description: "Remove the claimed email domain for an organization.",
  annotations: {
    title: "Clear Organization Domain",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    await ctx.storage.organizationDomains.clearDomain(org.id);

    return { success: true };
  },
});
