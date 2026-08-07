/**
 * Generic email providers that should be skipped for domain-based auto-join.
 */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "yandex.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "tutanota.com",
  "fastmail.com",
]);

export interface EmailUserLike {
  email: string;
  emailVerified?: boolean | null;
  name?: string | null;
}

export interface DomainRecordLike {
  joinMode: "off" | "auto" | "request";
  verificationStatus: "pending" | "verified";
}

export function emailDomainOf(email: string): string | null {
  const [localPart, domain, ...extraParts] = email.trim().split("@");

  if (!localPart || !domain || extraParts.length > 0) {
    return null;
  }

  return domain.toLowerCase();
}

export function isCorporateEmailDomain(domain: string): boolean {
  const normalizedDomain = domain.trim().toLowerCase();

  return (
    normalizedDomain.length > 0 && !GENERIC_EMAIL_DOMAINS.has(normalizedDomain)
  );
}

export function isVerifiedCorporateUser(user: EmailUserLike): boolean {
  const domain = emailDomainOf(user.email);

  return (
    user.emailVerified === true && !!domain && isCorporateEmailDomain(domain)
  );
}

export function domainToOrgSlug(domain: string): string {
  return domain
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function domainDisplayName(domain: string): string {
  const [firstLabel = ""] = domain.trim().toLowerCase().split(".");
  const name = firstLabel
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return name || "Workspace";
}

/**
 * Derives a human display name from an email local-part, e.g.
 * `stephanie.moraes@montecarlo.com.br` -> "Stephanie Moraes".
 *
 * Used to backfill `user.name` at signup for flows that never collect one
 * (email OTP, magic link, email/password), so invited members don't render
 * as "Unknown". Returns "" when nothing usable can be derived, so callers
 * can fall back to leaving the name empty.
 */
export function displayNameFromEmail(email: string): string {
  const [localPart = ""] = email.trim().split("@");

  return localPart
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function defaultOrgNameForUser(user: EmailUserLike): string {
  const firstName = user.name?.trim().split(/\s+/)[0];

  if (firstName) {
    return firstName;
  }

  const [localPart] = user.email.trim().split("@");

  return localPart || "Workspace";
}

export function isDiscoverableDomainRecord(record: DomainRecordLike): boolean {
  return record.verificationStatus === "verified" && record.joinMode !== "off";
}

export { GENERIC_EMAIL_DOMAINS };
