/**
 * Shared VM helper functions used across VM tools (VM_START, VM_DELETE).
 *
 * Centralizes:
 * - Auth + lookup boilerplate (requireVmEntry)
 * - Runtime detection logic (resolveRuntimeConfig)
 */

import type { VmMapEntry } from "@decocms/mesh-sdk";

import {
  requireAuth,
  requireOrganization,
  getUserId,
  type MeshContext,
} from "../../core/mesh-context";
import { PACKAGE_MANAGER_CONFIG } from "../../shared/runtime-defaults";
import type { PackageManager } from "../../shared/runtime-defaults";
import { readVmMap, resolveVm } from "./vm-map";

type RuntimeConfigMeta = {
  runtime?: {
    selected?: string | null;
    port?: string | null;
    path?: string | null;
  } | null;
};

/**
 * Extracts common auth + lookup boilerplate shared by all VM tools.
 * Validates auth, checks access, fetches and validates the Virtual MCP,
 * and returns the metadata and vmMap entry for the current user on the
 * specified branch. `entry` is null when no vm is registered for that pair.
 */
export async function requireVmEntry(
  input: { virtualMcpId: string; branch: string },
  ctx: MeshContext,
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
  const vmMap = readVmMap(metadata);
  const entry: VmMapEntry | null = resolveVm(vmMap, userId, input.branch);
  return { virtualMcp, metadata, userId, entry, organization };
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
  const port = runtime?.port ?? null;
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
