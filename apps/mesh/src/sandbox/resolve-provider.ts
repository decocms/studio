/**
 * Single source of truth for "which `SandboxProvider` should this request use?".
 *
 * Precedence (highest first):
 *
 *   1. **Caller override (`explicitKind`).** `SANDBOX_START` forwards
 *      `input.sandboxProviderKind` here; `ensureSandbox` callers pass the kind
 *      they already resolved. Binds the user's link for `user-desktop`.
 *
 *   2. **Per-run dispatch hint** (`ctx.sandboxPreference`). Set by
 *      `dispatch-run` from the resolved `DispatchTarget`. Honoring it without a
 *      sandboxMap read is the whole point: decopilot runs decided which sandbox
 *      kind to use upstream, and any DB lookup here would just confirm what they
 *      already know.
 *
 *   3. **Recorded sandboxMap kind.** The post-provision source of truth: a
 *      sandbox provisioned via `user-desktop` stays addressable through
 *      `user-desktop` even when env/default policy points at hosted
 *      `agent-sandbox`. This is what the events/proxy route uses — no ctx
 *      hint, just the recorded entry.
 *
 *   4. **Default policy** (`resolveDefaultKind`). Pre-provision
 *      fall-through: live link → `user-desktop`, else env kind.
 *
 * Returns a fully-bound `SandboxProvider` plus the resolved kind. Callers
 * never need to set `ctx.sandboxPreference` themselves — the resolver reads it
 * as input.
 */

import { parseBranchMap } from "@decocms/mesh-sdk";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProvider,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";

import type { StudioContext } from "../core/studio-context";
import { readSandboxMap } from "../tools/sandbox/sandbox-map";
import { buildDesktopProvider, getSandboxProviderByKind } from "./lifecycle";
import { getSettings } from "../settings";

export interface ResolveSandboxProviderArgs {
  /** User whose sandboxMap cell to read and (for `desktop`) whose link to bind. */
  userId: string;
  branch: string;
  /** Required to discover a first-class shared agent-sandbox session. */
  virtualMcpId?: string;
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
  ctx: StudioContext,
  args: ResolveSandboxProviderArgs,
): Promise<ResolvedSandboxProvider> {
  const { userId, branch, virtualMcpId, virtualMcpMetadata, explicitKind } =
    args;

  // 1. Caller override.
  if (explicitKind) {
    const provider = await bindProviderForKind(ctx, userId, explicitKind);
    return { provider, kind: explicitKind };
  }

  // 2. Per-run dispatch hint. `dispatch-run` already chose; honor it
  //    without touching sandboxMap. `agent-sandbox` is explicit hosted
  //    execution; `user-desktop` builds the desktop provider unconditionally;
  //    `cluster-default` means "use the provider the env/default policy points
  //    to" (legacy automation/default behavior).
  if (ctx.sandboxPreference === "agent-sandbox") {
    const provider = await bindProviderForKind(ctx, userId, "agent-sandbox");
    return { provider, kind: "agent-sandbox" };
  }
  if (ctx.sandboxPreference === "user-desktop") {
    const provider = await buildDesktopProvider(ctx, userId);
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
  const [firstRecorded, ...restRecorded] = await readRecordedKinds(ctx, {
    virtualMcpMetadata,
    virtualMcpId,
    userId,
    branch,
  });
  if (firstRecorded) {
    const preferred =
      restRecorded.length === 0
        ? firstRecorded
        : pickRecordedKind(firstRecorded, restRecorded);
    const provider = await bindProviderForKind(ctx, userId, preferred);
    return { provider, kind: preferred };
  }

  // 4. Default policy.
  const kind = resolveDefaultKind();
  const provider = await bindProviderForKind(ctx, userId, kind);
  return { provider, kind };
}

/**
 * All kinds recorded under `sandboxMap[userId][branch]`. Multiple kinds can coexist
 * as siblings — `SANDBOX_START` accepts an explicit `sandboxProviderKind`, and
 * `setSandboxMapEntry` preserves siblings. Callers that need exactly one kind
 * (`readRecordedKind`) tiebreak against the default policy.
 */
async function readRecordedKinds(
  ctx: StudioContext,
  args: {
    virtualMcpMetadata: Record<string, unknown> | null;
    virtualMcpId?: string;
    userId: string;
    branch: string;
  },
): Promise<SandboxProviderKind[]> {
  const cell = readSandboxMap(args.virtualMcpMetadata)[args.userId]?.[
    args.branch
  ];
  const parsed = cell ? parseBranchMap(cell) : {};
  const recorded = Object.keys(parsed) as SandboxProviderKind[];

  if (!getSettings().sharedAgentSandboxesEnabled) return recorded;

  // Legacy hosted metadata is deliberately ignored while shared mode is on.
  // Keep user-desktop entries intact and add hosted presence from the
  // first-class org-scoped session registry.
  const kinds: SandboxProviderKind[] = recorded.filter(
    (kind) => kind !== "agent-sandbox",
  );
  const organizationId = ctx.organization?.id;
  if (!organizationId || !args.virtualMcpId) return kinds;
  const session = await ctx.storage.agentSandboxSessions.find({
    organizationId,
    virtualMcpId: args.virtualMcpId,
    branch: args.branch,
  });
  if (session) kinds.unshift("agent-sandbox");
  return kinds;
}

/**
 * Picks one recorded kind when multiple siblings exist. Prefers the kind that
 * matches the current default policy (link online → `user-desktop`, else env
 * kind); otherwise falls back to the first recorded kind. This keeps the
 * events/proxy path deterministic across pods and matches what a fresh
 * SANDBOX_START with no explicit kind would have used.
 */
function pickRecordedKind(
  first: SandboxProviderKind,
  rest: SandboxProviderKind[],
): SandboxProviderKind {
  const preferred = resolveDefaultKind();
  if (preferred === first || rest.includes(preferred)) return preferred;
  return first;
}

function resolveDefaultKind(): SandboxProviderKind {
  return resolveSandboxProviderKindFromEnv();
}

async function bindProviderForKind(
  ctx: StudioContext,
  userId: string,
  kind: SandboxProviderKind,
): Promise<SandboxProvider> {
  if (kind !== "user-desktop") return getSandboxProviderByKind(ctx, kind);
  // Optimistic: build the desktop provider unconditionally. Operations through
  // it fail-fast over the tunnel if the daemon is gone (the VM-tool layer
  // reaps + respawns on proxy failure). No pre-flight liveness check.
  return buildDesktopProvider(ctx, userId);
}
