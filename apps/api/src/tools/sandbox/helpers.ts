/**
 * Shared sandbox helper functions used across sandbox tools (SANDBOX_START, SANDBOX_DELETE).
 *
 * Centralizes:
 * - Auth + lookup boilerplate (requireVmEntry)
 * - Runtime detection logic (resolveRuntimeConfig)
 */

import {
  ENV_VAR_KEY_RE,
  type RuntimeEnvEntry,
  type SandboxRecord,
  type SubmoduleCredential,
} from "@decocms/shared/sdk";
import {
  requireAuth,
  requireOrganization,
  getUserId,
  type StudioContext,
} from "../../core/studio-context";
import { PACKAGE_MANAGER_CONFIG } from "@decocms/shared/runtime-defaults";
import type { PackageManager } from "@decocms/shared/runtime-defaults";
import {
  isSandboxOwner,
  resolveSandboxUserId,
  threadIdFromBranch,
} from "./thread-repo";
import { resolveAgentSandboxRecord } from "./agent-sandbox-record";

export type RuntimeConfigMeta = {
  runtime?: {
    selected?: string | null;
    port?: string | null;
    path?: string | null;
    env?: RuntimeEnvEntry[] | null;
    submoduleCredentials?: SubmoduleCredential[] | null;
  } | null;
};

/**
 * Defensive reader for `metadata.runtime.env`. The DB column is JSON, so
 * the static cast to `RuntimeConfigMeta` can't be trusted — older rows or
 * hand-edited metadata may carry a non-array `env`, malformed entries, or
 * the wrong types under the discriminator. Returns only entries that
 * match the wire contract; everything else is silently dropped so a bad
 * row can't crash `resolveAndPushEnv`'s `for...of`.
 */
export function readValidatedRuntimeEnv(
  metadata: Record<string, unknown> | null | undefined,
): RuntimeEnvEntry[] | null {
  if (!metadata) return null;
  const runtime = (metadata as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const env = (runtime as { env?: unknown }).env;
  if (!Array.isArray(env)) return null;
  const out: RuntimeEnvEntry[] = [];
  for (const item of env) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.key !== "string" || !ENV_VAR_KEY_RE.test(e.key)) continue;
    if (e.kind === "literal" && typeof e.value === "string") {
      out.push({ key: e.key, kind: "literal", value: e.value });
      continue;
    }
    if (
      e.kind === "secret" &&
      typeof e.secretId === "string" &&
      e.secretId.length > 0
    ) {
      out.push({ key: e.key, kind: "secret", secretId: e.secretId });
    }
  }
  return out.length === 0 ? null : out;
}

/**
 * Defensive reader for `metadata.runtime.submoduleCredentials`. Same rationale
 * as `readValidatedRuntimeEnv`: the JSON metadata column is untrusted, so drop
 * any entry missing a string `host`/`secretId` rather than trusting the cast.
 */
export function readValidatedSubmoduleCredentials(
  metadata: Record<string, unknown> | null | undefined,
): SubmoduleCredential[] | null {
  if (!metadata) return null;
  const runtime = (metadata as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object") return null;
  const creds = (runtime as { submoduleCredentials?: unknown })
    .submoduleCredentials;
  if (!Array.isArray(creds)) return null;
  const out: SubmoduleCredential[] = [];
  for (const item of creds) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (
      typeof c.host === "string" &&
      c.host.length > 0 &&
      typeof c.secretId === "string" &&
      c.secretId.length > 0
    ) {
      out.push({ host: c.host, secretId: c.secretId });
    }
  }
  return out.length === 0 ? null : out;
}

/**
 * Extracts common auth + lookup boilerplate shared by all VM tools.
 * Validates auth, checks access, fetches and validates the Virtual MCP,
 * and returns the canonical hosted entry for the sandbox's OWNER. Thread-scoped
 * records fall back to thread metadata. `entry` is null when no hosted sandbox
 * is registered; legacy desktop records are never routed through this helper.
 *
 * `userId` is the caller (audit); `sandboxUserId` is who the sandbox is keyed by
 * — the same resolution SANDBOX_START uses. Mutating tool paths require those
 * identities to match, so a teammate cannot change the owner's sandbox.
 */
export async function requireVmEntry(
  input: {
    virtualMcpId: string;
    branch: string;
  },
  ctx: StudioContext,
) {
  requireAuth(ctx);
  const organization = requireOrganization(ctx);
  await ctx.access.check();
  const userId = getUserId(ctx);
  if (!userId) throw new Error("User ID required");
  const virtualMcp = await ctx.storage.virtualMcps.findById(input.virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    throw new Error("Virtual MCP not found");
  }
  const metadata = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const sandboxUserId = await resolveSandboxUserId(
    ctx,
    input.branch,
    userId,
    input.virtualMcpId,
  );
  if (!sandboxUserId) throw new Error("Thread not found for Virtual MCP");
  if (
    threadIdFromBranch(input.branch) &&
    !isSandboxOwner(userId, sandboxUserId)
  ) {
    throw new Error("Only the thread owner can change its sandbox");
  }
  const entry: SandboxRecord | null = await resolveAgentSandboxRecord({
    ctx,
    virtualMcpId: input.virtualMcpId,
    virtualMcpMetadata: metadata,
    sandboxUserId,
    branch: input.branch,
  });
  return { virtualMcp, metadata, userId, sandboxUserId, entry, organization };
}

/**
 * A valid dev-server port is a plain decimal string in 1-65535. The metadata
 * JSON column is untrusted (same rationale as `readValidatedRuntimeEnv`), and
 * `VIRTUAL_MCP_UPDATE`'s schema only requires a string — "", "0", or garbage
 * like "abc" all pass validation there. Treating anything but a valid port as
 * unset keeps `start.ts`'s `Number(port)` from ever producing `0`/`NaN` as a
 * `devPort` sent to the sandbox provider.
 */
function parseValidPort(port: string | null): string | null {
  if (port === null || !/^\d+$/.test(port)) return null;
  const n = Number(port);
  return n >= 1 && n <= 65535 ? port : null;
}

/**
 * Resolves package manager and runtime config from Virtual MCP metadata.
 * Returns null packageManager/runtime when no package manager is selected
 * (clone-only mode for non-JS repos). `port` is null unless the user
 * explicitly pinned one — runners free to pick a free port otherwise.
 */
export function resolveRuntimeConfig(metadata: Record<string, unknown>) {
  const runtime = (metadata as RuntimeConfigMeta).runtime ?? null;
  const selected = runtime?.selected ?? null;
  const pm = selected as PackageManager | null;
  const port = parseValidPort(runtime?.port ?? null);
  const packageManagerPath = runtime?.path ?? null;

  if (!pm || !(pm in PACKAGE_MANAGER_CONFIG)) {
    return {
      packageManager: null,
      runtime: null,
      port,
      packageManagerPath,
      runtimeBinPath: null,
    };
  }

  const pmRuntime = PACKAGE_MANAGER_CONFIG[pm].runtime;
  const runtimeBinPath =
    pmRuntime === "deno"
      ? "/opt/deno/bin"
      : pmRuntime === "bun"
        ? "/opt/bun/bin"
        : null;

  return {
    packageManager: pm,
    runtime: pmRuntime,
    port,
    packageManagerPath,
    runtimeBinPath,
  };
}
