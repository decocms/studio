/**
 * Single source of truth for "which `SandboxProvider` should this request use?".
 *
 * Precedence (highest first):
 *
 *   1. **Caller override (`explicitKind`).** `VM_START` forwards
 *      `input.sandboxProviderKind` here; `ensureVm` callers pass the kind
 *      they already resolved. Binds the user's link for `remote-user`.
 *
 *   2. **Per-run dispatch hint** (`ctx.sandboxPreference` /
 *      `ctx.linkForCurrentRun`). Set by `dispatch-run` from the resolved
 *      `DispatchTarget`. Honoring it without a vmMap read is the whole
 *      point: decopilot runs decided which sandbox kind to use upstream,
 *      and any DB lookup here would just confirm what they already know.
 *
 *   3. **Recorded vmMap kind.** The post-provision source of truth: a
 *      sandbox provisioned via `remote-user` stays addressable through
 *      `remote-user` even on a cluster whose env kind is something else
 *      (`agent-sandbox`, `docker`, …). This is what the events/proxy
 *      route uses — no ctx hint, just the recorded entry.
 *
 *   4. **Default policy** (`resolveDefaultSandboxProviderKind`). Pre-
 *      provision fall-through: live link → `remote-user`, else env kind.
 *
 * Returns a fully-bound `SandboxProvider` plus the resolved kind. Callers
 * never need to set `ctx.sandboxPreference` / `ctx.linkForCurrentRun`
 * themselves — the resolver reads them as input.
 */

import { parseBranchMap } from "@decocms/mesh-sdk";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProvider,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";

import type { MeshContext } from "../core/mesh-context";
import { readVmMap } from "../tools/vm/vm-map";
import { buildRemoteUserProvider, getSandboxProviderByKind } from "./lifecycle";
import { resolveDefaultSandboxProviderKind } from "./resolve-default-provider-kind";

export interface ResolveSandboxProviderArgs {
  /** User whose vmMap cell to read and (for `remote-user`) whose link to bind. */
  userId: string;
  branch: string;
  /** Raw `virtualmcp.metadata` JSON column. May be null. */
  virtualMcpMetadata: Record<string, unknown> | null;
  /**
   * Caller-provided override (e.g. `VM_START`'s `input.sandboxProviderKind`).
   * When set, takes precedence over both the vmMap entry and the default
   * policy. The resolver still binds the user's link for `remote-user`.
   */
  explicitKind?: SandboxProviderKind;
}

export interface ResolvedSandboxProvider {
  provider: SandboxProvider;
  /** The kind the provider was bound for. Callers persisting vmMap rows
   *  use this so the recorded kind matches what was actually constructed. */
  kind: SandboxProviderKind;
}

export async function resolveSandboxProvider(
  ctx: MeshContext,
  args: ResolveSandboxProviderArgs,
): Promise<ResolvedSandboxProvider> {
  const { userId, branch, virtualMcpMetadata, explicitKind } = args;

  // 1. Caller override.
  if (explicitKind) {
    const provider = await bindProviderForKind(ctx, userId, explicitKind);
    return { provider, kind: explicitKind };
  }

  // 2. Per-run dispatch hint. `dispatch-run` already chose; honor it
  //    without touching vmMap. `remote-user` carries its link inline;
  //    `default` means "use the cluster runner the env points to".
  if (ctx.sandboxPreference === "remote-user" && ctx.linkForCurrentRun) {
    const provider = await buildRemoteUserProvider(ctx, ctx.linkForCurrentRun);
    return { provider, kind: "remote-user" };
  }
  if (ctx.sandboxPreference === "default") {
    const kind = resolveSandboxProviderKindFromEnv();
    const provider = await getSandboxProviderByKind(ctx, kind);
    return { provider, kind };
  }

  // 3. Recorded vmMap kind. Tiebreak against the default policy so that when
  //    multiple sibling kinds were persisted (e.g. the user ran VM_START
  //    twice with different `sandboxProviderKind` values), the events/proxy
  //    path consistently picks the one matching current intent
  //    (link online → `remote-user`, else env kind) instead of whatever
  //    `Object.keys` happens to enumerate first.
  const recordedKinds = readRecordedKinds(virtualMcpMetadata, userId, branch);
  if (recordedKinds.length > 0) {
    const preferred =
      recordedKinds.length === 1
        ? recordedKinds[0]
        : await pickRecordedKind(ctx, userId, recordedKinds);
    const provider = await bindProviderForKind(ctx, userId, preferred);
    return { provider, kind: preferred };
  }

  // 4. Default policy.
  const kind = await resolveDefaultKind(ctx, userId);
  const provider = await bindProviderForKind(ctx, userId, kind);
  return { provider, kind };
}

/**
 * All kinds recorded under `vmMap[userId][branch]`. Multiple kinds can coexist
 * as siblings — `VM_START` accepts an explicit `sandboxProviderKind`, and
 * `setVmMapEntry` preserves siblings. Callers that need exactly one kind
 * (`readRecordedKind`) tiebreak against the default policy.
 */
function readRecordedKinds(
  metadata: Record<string, unknown> | null,
  userId: string,
  branch: string,
): SandboxProviderKind[] {
  const cell = readVmMap(metadata)[userId]?.[branch];
  if (!cell) return [];
  const parsed = parseBranchMap(cell);
  return Object.keys(parsed) as SandboxProviderKind[];
}

/**
 * Picks one recorded kind when multiple siblings exist. Prefers the kind that
 * matches the current default policy (link online → `remote-user`, else env
 * kind); otherwise falls back to the first recorded kind. This keeps the
 * events/proxy path deterministic across pods and matches what a fresh
 * VM_START with no explicit kind would have used.
 */
async function pickRecordedKind(
  ctx: MeshContext,
  userId: string,
  recorded: SandboxProviderKind[],
): Promise<SandboxProviderKind> {
  const preferred = await resolveDefaultKind(ctx, userId);
  if (recorded.includes(preferred)) return preferred;
  return recorded[0];
}

async function resolveDefaultKind(
  ctx: MeshContext,
  userId: string,
): Promise<SandboxProviderKind> {
  if (!ctx.linkRegistry) return resolveSandboxProviderKindFromEnv();
  return resolveDefaultSandboxProviderKind(userId, {
    linkRegistry: ctx.linkRegistry,
    resolveEnvKind: resolveSandboxProviderKindFromEnv,
  });
}

async function bindProviderForKind(
  ctx: MeshContext,
  userId: string,
  kind: SandboxProviderKind,
): Promise<SandboxProvider> {
  if (kind !== "remote-user") return getSandboxProviderByKind(ctx, kind);

  if (!ctx.linkRegistry) {
    throw new Error(
      "remote-user sandbox provider requires ctx.linkRegistry to be wired (set on MeshContextConfig).",
    );
  }
  const link = await ctx.linkRegistry.get(userId);
  if (!link) {
    throw new Error(
      `No link daemon registered for user "${userId}". Start one with \`deco link\` (or run \`bun run dev --local-sandbox-provider\` for dev).`,
    );
  }
  return buildRemoteUserProvider(ctx, link);
}
