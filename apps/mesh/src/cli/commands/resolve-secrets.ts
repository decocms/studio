/**
 * Resolve Secrets
 *
 * Pure function that resolves BETTER_AUTH_SECRET, ENCRYPTION_KEY, and
 * LOCAL_ADMIN_PASSWORD from a saved secrets file, generating new values
 * only when a key is truly missing (undefined), NOT when it's an empty string.
 */
import crypto from "crypto";

export interface SecretsFile {
  BETTER_AUTH_SECRET?: string;
  ENCRYPTION_KEY?: string;
  LOCAL_ADMIN_PASSWORD?: string;
}

export interface ResolvedSecrets {
  secrets: Required<SecretsFile>;
  modified: boolean;
}

/**
 * Resolve secrets from saved file and environment.
 *
 * - If an env var is set, it takes precedence (the saved value is kept as-is).
 * - If the saved value is present (including empty string ""), it is used.
 * - Only when the saved value is undefined/null is a new random value generated.
 */
export function resolveSecrets(
  saved: SecretsFile,
  env: { BETTER_AUTH_SECRET?: string; ENCRYPTION_KEY?: string },
): ResolvedSecrets {
  let modified = false;

  // BETTER_AUTH_SECRET
  let betterAuthSecret: string;
  if (env.BETTER_AUTH_SECRET) {
    betterAuthSecret = env.BETTER_AUTH_SECRET;
  } else if (saved.BETTER_AUTH_SECRET != null) {
    betterAuthSecret = saved.BETTER_AUTH_SECRET;
  } else {
    betterAuthSecret = crypto.randomBytes(32).toString("base64");
    modified = true;
  }

  // ENCRYPTION_KEY
  let encryptionKey: string;
  if (env.ENCRYPTION_KEY) {
    encryptionKey = env.ENCRYPTION_KEY;
  } else if (saved.ENCRYPTION_KEY != null) {
    encryptionKey = saved.ENCRYPTION_KEY;
  } else {
    encryptionKey = crypto.randomBytes(32).toString("base64");
    modified = true;
  }

  // LOCAL_ADMIN_PASSWORD
  let localAdminPassword: string;
  if (saved.LOCAL_ADMIN_PASSWORD != null) {
    localAdminPassword = saved.LOCAL_ADMIN_PASSWORD;
  } else {
    localAdminPassword = crypto.randomBytes(24).toString("base64");
    modified = true;
  }

  return {
    secrets: {
      BETTER_AUTH_SECRET: betterAuthSecret,
      ENCRYPTION_KEY: encryptionKey,
      LOCAL_ADMIN_PASSWORD: localAdminPassword,
    },
    modified,
  };
}
