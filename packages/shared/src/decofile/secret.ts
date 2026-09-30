/**
 * Deco secrets are `website/loaders/secret.ts` blocks: `{ name, encrypted }`.
 * The runtime reads `Deno.env[name]` or DECRYPTS `encrypted` (hex AES-CBC with
 * the site's `DECO_CRYPTO_KEY`); it never encrypts. Editors must store the hex
 * returned by the site's `secrets/encrypt.ts` action, never the raw value.
 */

export const SECRET_LOADER_RESOLVE_TYPE = "website/loaders/secret.ts";

/** Invoke keys of the site action that encrypts with the site's key; `$live` is for older sites. */
export const SECRET_ENCRYPT_ACTION_KEYS = [
  "website/actions/secrets/encrypt.ts",
  "$live/actions/secrets/encrypt.ts",
] as const;

const ENCRYPTED_HEX_RE = /^(?:[0-9a-f]{2})*$/i;

export function isSecretBlock(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resolveType = (value as Record<string, unknown>).__resolveType;
  return (
    typeof resolveType === "string" &&
    (resolveType.endsWith("/secret.ts") ||
      resolveType.includes("loaders/secret"))
  );
}

/** Empty means "no stored secret" (the runtime falls back to `name`). */
export function isEncryptedSecretValue(value: unknown): value is string {
  return typeof value === "string" && ENCRYPTED_HEX_RE.test(value);
}

export class PlaintextSecretError extends Error {
  constructor(readonly path: string) {
    super(
      `Secret at "${path}" is not encrypted. Re-enter it in the Secret field so it is encrypted before saving.`,
    );
    this.name = "PlaintextSecretError";
  }
}

/**
 * Persistence boundary for block data: drops the transient `value` older
 * editors attached to secret blocks and throws {@link PlaintextSecretError}
 * when an `encrypted` field isn't hex, so a raw secret is never written.
 */
export function sanitizeSecretsForPersistence<T>(data: T, path = ""): T {
  if (Array.isArray(data)) {
    return data.map((item, i) =>
      sanitizeSecretsForPersistence(item, `${path}/${i}`),
    ) as T;
  }
  if (!data || typeof data !== "object") return data;
  const entries = Object.entries(data as Record<string, unknown>);
  if (isSecretBlock(data)) {
    const encrypted = (data as Record<string, unknown>).encrypted;
    if (encrypted !== undefined && !isEncryptedSecretValue(encrypted)) {
      throw new PlaintextSecretError(path || "/");
    }
    return Object.fromEntries(entries.filter(([key]) => key !== "value")) as T;
  }
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      sanitizeSecretsForPersistence(value, `${path}/${key}`),
    ]),
  ) as T;
}
