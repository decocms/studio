/**
 * The billing notice a deployment admin pins on an organization.
 *
 * `warn` is a banner over an otherwise working org; `block` replaces the org's
 * UI with the notice and makes the server refuse control-plane writes. Both
 * carry admin-authored text — this is the one place in the product where a
 * human types the copy a tenant reads, so it is data, not a translated string.
 *
 * Shared because the admin API validates writes with these schemas and the web
 * shell renders from the same shape.
 */

import { z } from "zod";

export const ORG_NOTICE_SEVERITIES = ["warn", "block"] as const;

export const OrgNoticeSeveritySchema = z.enum(ORG_NOTICE_SEVERITIES);

export type OrgNoticeSeverity = z.infer<typeof OrgNoticeSeveritySchema>;

/** Bounds the free-text fields an admin types, so a paste can't fill the row. */
const MAX_NOTICE_TITLE_LENGTH = 200;
const MAX_NOTICE_MESSAGE_LENGTH = 2000;
const MAX_NOTICE_CTA_LABEL_LENGTH = 60;
const MAX_NOTICE_CTA_URL_LENGTH = 2000;

/**
 * The CTA target. Restricted to absolute http(s) so the banner can never render
 * a `javascript:` link typed by a compromised admin session, and so the button
 * is unambiguously an external invoice link rather than an in-app route.
 */
const CtaUrlSchema = z
  .string()
  .max(MAX_NOTICE_CTA_URL_LENGTH)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "ctaUrl must be an absolute http(s) URL" },
  );

/** What the admin editor writes. `id` is server-assigned. */
export const OrgNoticeInputSchema = z
  .object({
    severity: OrgNoticeSeveritySchema,
    title: z.string().trim().min(1).max(MAX_NOTICE_TITLE_LENGTH),
    message: z.string().trim().min(1).max(MAX_NOTICE_MESSAGE_LENGTH),
    ctaLabel: z
      .string()
      .trim()
      .max(MAX_NOTICE_CTA_LABEL_LENGTH)
      .nullable()
      .optional(),
    ctaUrl: CtaUrlSchema.nullable().optional(),
  })
  /** Label and URL travel together: one without the other renders a dead button. */
  .refine((notice) => !notice.ctaLabel === !notice.ctaUrl, {
    message: "ctaLabel and ctaUrl must be set together",
    path: ["ctaUrl"],
  });

export type OrgNoticeInput = z.infer<typeof OrgNoticeInputSchema>;

/**
 * What a member of the org sees. Deliberately narrower than the stored row:
 * who set the notice and when is operator data, not tenant-facing.
 */
export interface OrgNoticePublic {
  severity: OrgNoticeSeverity;
  title: string;
  message: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
}
