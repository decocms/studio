/**
 * Single source of truth for "which `SandboxProvider` should this request use?".
 *
 * Precedence (highest first):
 *
 *   1. **Caller override (`explicitKind`).** `SANDBOX_START` forwards
 *      `input.sandboxProviderKind` here; `ensureSandbox` callers pass the kind
 *      they already resolved. Binds the user's link for `user-desktop`.
 *
 *   2. **Per-run dispatch hint** (`ctx.sandboxPreference` /
 *      `ctx.linkForCurrentRun`). Set by `dispatch-run` from the resolved
 *      `DispatchTarget`. Honoring it without a sandboxMap read is the whole
 *      point: decopilot runs decided which sandbox kind to use upstream,
 *      and any DB lookup here would just confirm what they already know.
 *
 *   3. **Recorded sandboxMap kind.** The post-provision source of truth: a
 *      sandbox provisioned via `user-desktop` stays addressable through
 *      `user-desktop` even on a cluster whose env kind is something else
 *      (`cluster`, `local-docker`, …). This is what the events/proxy
 *      route uses — no ctx hint, just the recorded entry.
 *
 *   4. **Default policy** (`resolveDefaultSandboxProviderKind`). Pre-
 *      provision fall-through: live link → `user-desktop`, else env kind.
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
import { readSandboxMap } from "../tools/sandbox/sandbox-map";
import { buildDesktopProvider, getSandboxProviderByKind } from "./lifecycle";
import { resolveDefaultSandboxProviderKind } from "./resolve-default-provider-kind";

export interface ResolveSandboxProviderArgs {
  /** User whose sandboxMap cell to read and (for `desktop`) whose link to bind. */
  userId: string;
  branch: string;
  /** Raw `virtualmcp.metadata` JSON column. May be null. */
  virtualMcpMetadata: Record<string, unknown> | null;
  /**
   * Caller-provided override (e.g. `SANDBOX_START`'s `input.sandboxProviderKind`).
   * When set, takes precedence over both the sandboxMap entry and the default
   * policy. The resolver still binds the user's link for `user-desktop`.
   */
  explicitKind?: SandboxProviderKind;
}

export interface ResolvedSandboxProvider {
  provider: SandboxProvider;
  /** The kind the provider was bound for. Callers persisting sandboxMap rows
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
  //    without touching sandboxMap. `user-desktop` carries its link inline;
  //    `cluster-default` means "use the cluster runner the env points to".
  if (ctx.sandboxPreference === "user-desktop" && ctx.linkForCurrentRun) {
    const provider = await buildDesktopProvider(ctx);
    return { provider, kind: "user-desktop" };
  }
  if (ctx.sandboxPreference === "cluster-default") {
    // Route through `bindProviderForKind` so that env kind === "user-desktop"
    // (the default in local dev) still binds the user's link instead of
    // calling `instantiate("user-desktop")` directly, which throws. Without
    // this, background fires (cron/webhook/event automations) blow up
    // here because `dispatch-run` defaults their target to local/default
    // and never sets `sandboxPreference="user-desktop"` with a link.
    const kind = resolveSandboxProviderKindFromEnv();
    const provider = await bindProviderForKind(ctx, userId, kind);
    return { provider, kind };
  }

  // 3. Recorded sandboxMap kind. Tiebreak against the default policy so that when
  //    multiple sibling kinds were persisted (e.g. the user ran SANDBOX_START
  //    twice with different `sandboxProviderKind` values), the events/proxy
  //    path consistently picks the one matching current intent
  //    (link online → `desktop`, else env kind) instead of whatever
  //    `Object.keys` happens to enumerate first.
  const [firstRecorded, ...restRecorded] = readRecordedKinds(
    virtualMcpMetadata,
    userId,
    branch,
  );
  if (firstRecorded) {
    const preferred =
      restRecorded.length === 0
        ? firstRecorded
        : await pickRecordedKind(ctx, userId, firstRecorded, restRecorded);
    const provider = await bindProviderForKind(ctx, userId, preferred);
    return { provider, kind: preferred };
  }

  // 4. Default policy.
  const kind = await resolveDefaultKind(ctx, userId);
  const provider = await bindProviderForKind(ctx, userId, kind);
  return { provider, kind };
}

/**
 * All kinds recorded under `sandboxMap[userId][branch]`. Multiple kinds can coexist
 * as siblings — `SANDBOX_START` accepts an explicit `sandboxProviderKind`, and
 * `setSandboxMapEntry` preserves siblings. Callers that need exactly one kind
 * (`readRecordedKind`) tiebreak against the default policy.
 */
function readRecordedKinds(
  metadata: Record<string, unknown> | null,
  userId: string,
  branch: string,
): SandboxProviderKind[] {
  const cell = readSandboxMap(metadata)[userId]?.[branch];
  if (!cell) return [];
  const parsed = parseBranchMap(cell);
  return Object.keys(parsed) as SandboxProviderKind[];
}

/**
 * Picks one recorded kind when multiple siblings exist. Prefers the kind that
 * matches the current default policy (link online → `user-desktop`, else env
 * kind); otherwise falls back to the first recorded kind. This keeps the
 * events/proxy path deterministic across pods and matches what a fresh
 * SANDBOX_START with no explicit kind would have used.
 */
async function pickRecordedKind(
  ctx: MeshContext,
  userId: string,
  first: SandboxProviderKind,
  rest: SandboxProviderKind[],
): Promise<SandboxProviderKind> {
  const preferred = await resolveDefaultKind(ctx, userId);
  if (preferred === first || rest.includes(preferred)) return preferred;
  return first;
}

async function resolveDefaultKind(
  ctx: MeshContext,
  userId: string,
): Promise<SandboxProviderKind> {
  if (!ctx.linkClaimRegistry) return resolveSandboxProviderKindFromEnv();
  return resolveDefaultSandboxProviderKind(userId, {
    linkClaimRegistry: ctx.linkClaimRegistry,
    resolveEnvKind: resolveSandboxProviderKindFromEnv,
  });
}

async function bindProviderForKind(
  ctx: MeshContext,
  userId: string,
  kind: SandboxProviderKind,
): Promise<SandboxProvider> {
  if (kind !== "user-desktop") return getSandboxProviderByKind(ctx, kind);

  if (!ctx.linkClaimRegistry) {
    throw new Error(
      "user-desktop sandbox provider requires ctx.linkClaimRegistry to be wired (set on MeshContextConfig).",
    );
  }
  const link = await ctx.linkClaimRegistry.get(userId);
  if (!link) {
    throw new Error(
      `No link daemon registered for user "${userId}". Start one with \`deco link\` (or run \`bun run dev --local-sandbox-provider\` for dev).`,
    );
  }
  return buildDesktopProvider(ctx);
}
