import { sanitizeSecretsForPersistence } from "./secret";

/**
 * JSON text with object keys sorted at every depth. Everything else follows
 * `JSON.stringify` (undefined properties dropped, undefined array slots become
 * `null`), so a value and its JSON round trip serialize identically.
 */
export function canonicalBlockJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      sorted[key] = (v as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/**
 * Identifies a block's content, so a writer can say which version its edit was
 * made against. Editor and API must agree on it: both hash the persisted form
 * (secrets sanitized, keys sorted), whatever key order or transient secret
 * `value` the in-memory copy carries. Throws {@link PlaintextSecretError} for a
 * value that could never be persisted.
 */
export async function decoBlockFingerprint(value: unknown): Promise<string> {
  const text = canonicalBlockJson(sanitizeSecretsForPersistence(value));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
