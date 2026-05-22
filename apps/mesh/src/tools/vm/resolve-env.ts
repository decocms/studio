import type { RuntimeEnvEntry } from "@decocms/mesh-sdk";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import {
  SecretAccessDeniedError,
  SecretNotFoundError,
} from "../../storage/secrets";
import type { MeshContext } from "../../core/mesh-context";

interface ResolveAndPushParams {
  ctx: MeshContext;
  runner: SandboxProvider;
  handle: string;
  orgId: string;
  userId: string;
  entries: RuntimeEnvEntry[] | null | undefined;
}

/**
 * Resolves env entries declared on a virtual MCP (literal | secret) into
 * a flat KEY→value map and PUTs it to the sandbox daemon's
 * /_decopilot_vm/config so the resolved env is available before install +
 * dev script run.
 *
 * Secrets that fail to resolve (deleted by the owner, or user-scoped to a
 * different caller) are logged and skipped — boot continues without that
 * key rather than crashing the whole start.
 */
export async function resolveAndPushEnv({
  ctx,
  runner,
  handle,
  orgId,
  userId,
  entries,
}: ResolveAndPushParams): Promise<void> {
  if (!entries || entries.length === 0) return;

  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.kind === "literal") {
      env[entry.key] = entry.value;
      continue;
    }
    try {
      const { value } = await ctx.storage.secrets.resolveById(
        entry.secretId,
        orgId,
        userId,
      );
      env[entry.key] = value;
    } catch (err) {
      if (
        err instanceof SecretNotFoundError ||
        err instanceof SecretAccessDeniedError
      ) {
        console.warn(
          `[SANDBOX_START] skipping env ${entry.key}: ${err.message}. Re-link or recreate the secret to restore.`,
        );
        continue;
      }
      throw err;
    }
  }

  if (Object.keys(env).length === 0) return;

  const res = await runner.proxyDaemonRequest(handle, "/_decopilot_vm/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ env }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    console.warn(
      `[SANDBOX_START] daemon rejected env patch (${res.status}): ${body}`,
    );
  }
}
