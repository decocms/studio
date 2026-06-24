import { resolveTxt } from "node:dns/promises";

/**
 * Subdomain under which the verification TXT record must be published, e.g.
 * `_deco-verify.acme.com`.
 */
const DOMAIN_VERIFICATION_PREFIX = "_deco-verify";

/** The DNS name an org owner adds the TXT record at. */
export function verificationRecordName(domain: string): string {
  return `${DOMAIN_VERIFICATION_PREFIX}.${domain.toLowerCase()}`;
}

/** Generate the opaque token published in the TXT record. */
export function generateVerificationToken(): string {
  return `deco-verify-${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * TXT lookup, injectable so the pure matching logic can be unit-tested without
 * touching the network. `resolveTxt` returns chunked strings per record; we
 * join the chunks before comparing.
 */
type TxtResolver = (name: string) => Promise<string[][]>;

export async function checkDomainTxt(
  domain: string,
  token: string,
  resolver: TxtResolver = resolveTxt,
): Promise<boolean> {
  if (!token) return false;
  try {
    const records = await resolver(verificationRecordName(domain));
    return records.some((chunks) => chunks.join("").trim() === token);
  } catch {
    // NXDOMAIN / no TXT record / transient resolver error — treat as unverified.
    return false;
  }
}
