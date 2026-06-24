/**
 * Organization domain tools.
 *
 * An org can claim multiple email domains. A domain is trusted via two methods:
 *   - "email": the claimer's own verified email matches → trusted immediately.
 *   - "dns":   any other domain → must publish a TXT record and be verified.
 *
 * Only verified domains can be put into a discoverable join mode (auto/request).
 */

import { z } from "zod";
import { GENERIC_EMAIL_DOMAINS } from "../../auth";
import {
  checkDomainTxt,
  generateVerificationToken,
  verificationRecordName,
} from "../../auth/domain-verification";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import type { OrganizationDomain } from "../../storage/types";

const DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const JOIN_MODE = z.enum(["off", "auto", "request"]);

const domainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  joinMode: JOIN_MODE,
  verificationStatus: z.enum(["pending", "verified"]),
  verificationMethod: z.enum(["email", "dns"]).nullable(),
  verifiedAt: z.string().nullable(),
  /** DNS instructions — present only while a domain awaits DNS verification. */
  recordName: z.string().nullable(),
  recordValue: z.string().nullable(),
});

function toOutput(d: OrganizationDomain) {
  const pendingDns =
    d.verificationStatus === "pending" && Boolean(d.verificationToken);
  return {
    id: d.id,
    domain: d.domain,
    joinMode: d.joinMode,
    verificationStatus: d.verificationStatus,
    verificationMethod: d.verificationMethod,
    verifiedAt: d.verifiedAt ? new Date(d.verifiedAt).toISOString() : null,
    recordName: pendingDns ? verificationRecordName(d.domain) : null,
    recordValue: pendingDns ? d.verificationToken : null,
  };
}

function normalizeDomain(raw: string): string {
  const domain = raw.toLowerCase().trim();
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
  return domain;
}

export const ORGANIZATION_DOMAIN_LIST = defineTool({
  name: "ORGANIZATION_DOMAIN_LIST",
  description: "List the email domains claimed by an organization.",
  annotations: {
    title: "List Organization Domains",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ domains: z.array(domainSchema) }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const domains = await ctx.storage.organizationDomains.listByOrganizationId(
      org.id,
    );
    return { domains: domains.map(toOutput) };
  },
});

export const ORGANIZATION_DOMAIN_ADD = defineTool({
  name: "ORGANIZATION_DOMAIN_ADD",
  description:
    "Claim an email domain for an organization. If the caller's verified email matches the domain it is trusted immediately; otherwise it requires DNS verification.",
  annotations: {
    title: "Add Organization Domain",
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
      .describe("Domain to claim, e.g. acme.com"),
    joinMode: JOIN_MODE.optional().describe(
      "Initial join mode (only applied when the domain is trusted immediately via email match).",
    ),
  }),
  outputSchema: domainSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const domain = normalizeDomain(input.domain);

    const userEmail = ctx.auth.user?.email;
    const userDomain = userEmail?.split("@")[1]?.toLowerCase();
    const emailMatches =
      Boolean(ctx.auth.user?.emailVerified) && userDomain === domain;

    const existing = await ctx.storage.organizationDomains.getByOrgAndDomain(
      org.id,
      domain,
    );
    if (existing) {
      // Promote a still-pending domain to verified when the caller's email now
      // matches (email trust). Leave joinMode alone — don't clobber intent.
      if (existing.verificationStatus !== "verified" && emailMatches) {
        const upgraded = await ctx.storage.organizationDomains.markVerified(
          existing.id,
          "email",
        );
        return toOutput(upgraded);
      }
      return toOutput(existing);
    }

    const created = emailMatches
      ? await ctx.storage.organizationDomains.add(org.id, domain, {
          joinMode: input.joinMode ?? "off",
          verificationStatus: "verified",
          verificationMethod: "email",
        })
      : await ctx.storage.organizationDomains.add(org.id, domain, {
          joinMode: "off",
          verificationStatus: "pending",
          verificationToken: generateVerificationToken(),
        });

    return toOutput(created);
  },
});

export const ORGANIZATION_DOMAIN_UPDATE = defineTool({
  name: "ORGANIZATION_DOMAIN_UPDATE",
  description:
    "Set the join mode for a claimed domain. Discoverable modes (auto/request) require the domain to be verified.",
  annotations: {
    title: "Update Organization Domain",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    joinMode: JOIN_MODE,
  }),
  outputSchema: domainSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const domain = await ctx.storage.organizationDomains.getById(input.id);
    if (!domain || domain.organizationId !== org.id) {
      throw new Error("Domain not found");
    }

    if (input.joinMode !== "off" && domain.verificationStatus !== "verified") {
      throw new Error(
        "Verify the domain before enabling auto-join or requests.",
      );
    }

    const updated = await ctx.storage.organizationDomains.updateJoinMode(
      input.id,
      input.joinMode,
    );
    return toOutput(updated);
  },
});

export const ORGANIZATION_DOMAIN_VERIFY = defineTool({
  name: "ORGANIZATION_DOMAIN_VERIFY",
  description:
    "Check the DNS TXT record for a pending domain and mark it verified if present.",
  annotations: {
    title: "Verify Organization Domain",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ verified: z.boolean(), domain: domainSchema }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const domain = await ctx.storage.organizationDomains.getById(input.id);
    if (!domain || domain.organizationId !== org.id) {
      throw new Error("Domain not found");
    }

    if (domain.verificationStatus === "verified") {
      return { verified: true, domain: toOutput(domain) };
    }
    if (!domain.verificationToken) {
      throw new Error("Domain has no pending DNS verification.");
    }

    const ok = await checkDomainTxt(domain.domain, domain.verificationToken);
    if (!ok) {
      return { verified: false, domain: toOutput(domain) };
    }

    const verified = await ctx.storage.organizationDomains.markVerified(
      input.id,
      "dns",
    );
    return { verified: true, domain: toOutput(verified) };
  },
});

export const ORGANIZATION_DOMAIN_REMOVE = defineTool({
  name: "ORGANIZATION_DOMAIN_REMOVE",
  description: "Remove a claimed domain from an organization.",
  annotations: {
    title: "Remove Organization Domain",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const org = requireOrganization(ctx);
    const domain = await ctx.storage.organizationDomains.getById(input.id);
    if (!domain || domain.organizationId !== org.id) {
      throw new Error("Domain not found");
    }

    await ctx.storage.organizationDomains.removeById(input.id);
    return { success: true };
  },
});
