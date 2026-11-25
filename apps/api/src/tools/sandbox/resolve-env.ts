import type { RuntimeEnvEntry } from "@decocms/shared/sdk";
import type { SandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import {
  SecretAccessDeniedError,
  SecretNotFoundError,
} from "../../storage/secrets";
import type { StudioContext } from "../../core/studio-context";
import { readBoundedText } from "../../lib/bounded-text";

/** Matches the cap `sandbox-proxy.ts` applies to `/_sandbox/config` responses. */
const CONFIG_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

interface ResolveParams {
  ctx: StudioContext;
  orgId: string;
  userId: string;
  entries: RuntimeEnvEntry[] | null | undefined;
  /**
   * The organization's `sandbox_build_env` flag. Off, build-scoped entries are
   * dropped and no `buildEnv` is produced, so nothing new reaches the daemon.
   */
  buildEnabled: boolean;
}

export interface ResolvedSandboxEnv {
  /** Runtime-scoped vars: install, dev server, exec. */
  env: Record<string, string>;
  /**
   * Build-scoped vars: git clone, submodule update and install only.
   * `undefined` when the flag is off; otherwise the whole set, empty included,
   * because the daemon replaces its build env with whatever it is sent.
   */
  buildEnv: Record<string, string> | undefined;
}

/**
 * Resolves env entries declared on a virtual MCP (literal | secret) into flat
 * KEY→value maps, split by scope.
 *
 * Secrets that fail to resolve (deleted by the owner, or user-scoped to a
 * different caller) are logged and skipped — boot continues without that
 * key rather than crashing the whole start.
 */
export async function resolveSandboxEnv({
  ctx,
  orgId,
  userId,
  entries,
  buildEnabled,
}: ResolveParams): Promise<ResolvedSandboxEnv> {
  const env: Record<string, string> = {};
  const buildEnv: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const isBuild = entry.scope === "build";
    if (isBuild && !buildEnabled) continue;
    const target = isBuild ? buildEnv : env;
    if (entry.kind === "literal") {
      target[entry.key] = entry.value;
      continue;
    }
    try {
      const { value } = await ctx.storage.secrets.resolveById(
        entry.secretId,
        orgId,
        userId,
      );
      target[entry.key] = value;
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
  return { env, buildEnv: buildEnabled ? buildEnv : undefined };
}

/**
 * PUTs resolved env to the sandbox daemon's /_sandbox/config. `env` is a
 * per-key merge on the daemon, so an empty one is not sent; `buildEnv` is a
 * whole-set replacement, so it is sent whenever it is defined — that is how a
 * deleted build var leaves a running sandbox.
 *
 * `only: "build"` leaves `env` out: an env change is a transition the daemon
 * restarts the dev server for, which a clone step has no reason to cause.
 */
export async function pushSandboxEnv({
  runner,
  handle,
  resolved,
  only,
}: {
  runner: Pick<SandboxProvider, "proxyDaemonRequest">;
  handle: string;
  resolved: ResolvedSandboxEnv;
  only?: "build";
}): Promise<void> {
  const patch: {
    env?: Record<string, string>;
    buildEnv?: Record<string, string>;
  } = {};
  if (only !== "build" && Object.keys(resolved.env).length > 0) {
    patch.env = resolved.env;
  }
  if (resolved.buildEnv) patch.buildEnv = resolved.buildEnv;
  if (!patch.env && !patch.buildEnv) return;

  const res = await runner.proxyDaemonRequest(handle, "/_sandbox/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await readBoundedText(res, CONFIG_RESPONSE_MAX_BYTES).catch(
      () => res.statusText,
    );
    console.warn(
      `[SANDBOX_START] daemon rejected env patch (${res.status}): ${body}`,
    );
  }
}
