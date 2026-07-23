import type { SubmoduleCredential } from "@decocms/mesh-sdk";
import {
  SecretAccessDeniedError,
  SecretNotFoundError,
} from "../../storage/secrets";
import type { StudioContext } from "../../core/studio-context";

interface ResolveParams {
  ctx: StudioContext;
  orgId: string;
  userId: string;
  entries: SubmoduleCredential[] | null | undefined;
}

/**
 * Resolves the per-host submodule credentials declared on a virtual MCP
 * ({ host, secretId }) into { host, token } by reading each secret from the
 * credential vault. Unlike env (pushed after boot), these must be resolved
 * before `runner.ensure` so the token rides the INITIAL daemon config — the
 * clone (and its `git submodule update`) happens during provisioning.
 *
 * Secrets that fail to resolve (deleted, or user-scoped to another caller) are
 * logged and skipped so a stale reference doesn't block the whole start — the
 * affected submodule just fails auth (best-effort) in the daemon.
 */
export async function resolveSubmoduleCredentials({
  ctx,
  orgId,
  userId,
  entries,
}: ResolveParams): Promise<{ host: string; token: string }[]> {
  if (!entries || entries.length === 0) return [];

  const resolved: { host: string; token: string }[] = [];
  for (const entry of entries) {
    try {
      const { value } = await ctx.storage.secrets.resolveById(
        entry.secretId,
        orgId,
        userId,
      );
      resolved.push({ host: entry.host, token: value });
    } catch (err) {
      if (
        err instanceof SecretNotFoundError ||
        err instanceof SecretAccessDeniedError
      ) {
        console.warn(
          `[SANDBOX_START] skipping submodule credential for ${entry.host}: ${err.message}. Re-link or recreate the secret to restore.`,
        );
        continue;
      }
      throw err;
    }
  }
  return resolved;
}
