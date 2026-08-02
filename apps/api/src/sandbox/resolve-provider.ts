/**
 * Single source of truth for "which `SandboxProvider` should this request use?".
 *
 * Precedence (highest first):
 *
 *   1. **Caller override (`explicitKind`).** `SANDBOX_START` forwards
 *      `input.sandboxProviderKind` here; `ensureSandbox` callers pass the kind
 *      they already resolved.
 *
 *   2. **Per-run dispatch hint** (`ctx.sandboxPreference`). Set by
 *      `dispatch-run` from the resolved `DispatchTarget`. Honoring it without a
 *      sandboxMap read is the whole point: decopilot runs decided which sandbox
 *      kind to use upstream, and any DB lookup here would just confirm what they
 *      already know.
 *
 *   3. **Recorded sandboxMap kind.** The post-provision source of truth for
 *      which kind the events/proxy route addresses a sandbox through.
 *
 *   4. **Default policy** (`resolveDefaultKind`) — the env kind.
 *
 * `user-desktop` is a LEGACY value. The desktop link daemon that implemented it
 * is gone, but it is still persisted in `virtual_mcps.metadata.sandboxMap` rows
 * written before its removal (migration 092 normalized `desktop`/`remote-user`
 * into it), so it must stay *readable*. Every path that would have bound a
 * desktop provider now resolves to the hosted `agent-sandbox` one — old rows
 * keep parsing instead of throwing, and nothing new is ever recorded with it.
 *
 * Returns a fully-bound `SandboxProvider` plus the resolved kind. Callers
 * never need to set `ctx.sandboxPreference` themselves — the resolver reads it
 * as input.
 */

import { parseBranchMap } from "@decocms/shared/sdk";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProvider,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";

import type { StudioContext } from "../core/studio-context";
import { readSandboxMap } from "../tools/sandbox/sandbox-map";
import { getSandboxProviderByKind } from "./lifecycle";

export interface ResolveSandboxProviderArgs {
  /** User whose sandboxMap cell to read. */
  userId: string;
  branch: string;
  /** Raw `virtualmcp.metadata` JSON column. May be null. */
  virtualMcpMetadata: Record<string, unknown> | null;
  /**
   * Caller-provided override (e.g. `SANDBOX_START`'s `input.sandboxProviderKind`).
   * When set, takes precedence over both the sandboxMap entry and the default
   * policy.
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
  const { userId, branch, virtualMcpMetadata, explicitKind } = args;

  // 1. Caller override.
  if (explicitKind) {
    const provider = await bindProviderForKind(ctx, explicitKind);
    return { provider, kind: explicitKind };
  }

  // 2. Per-run dispatch hint. `dispatch-run` already chose; honor it
  //    without touching sandboxMap. `agent-sandbox` is explicit hosted
  //    execution; `cluster-default` means "use the provider the env/default
  //    policy points to" (legacy automation/default behavior).
  if (ctx.sandboxPreference === "agent-sandbox") {
    const provider = await bindProviderForKind(ctx, "agent-sandbox");
    return { provider, kind: "agent-sandbox" };
  }
  if (ctx.sandboxPreference === "cluster-default") {
    const kind = resolveSandboxProviderKindFromEnv();
    const provider = await bindProviderForKind(ctx, kind);
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
        : pickRecordedKind(firstRecorded, restRecorded);
    const provider = await bindProviderForKind(ctx, preferred);
    return { provider, kind: preferred };
  }

  // 4. Default policy.
  const kind = resolveDefaultKind();
  const provider = await bindProviderForKind(ctx, kind);
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
 * matches the current default policy (the env kind); otherwise falls back to
 * the first recorded kind. This keeps the events/proxy path deterministic
 * across pods and matches what a fresh SANDBOX_START with no explicit kind
 * would have used.
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
  kind: SandboxProviderKind,
): Promise<SandboxProvider> {
  // `user-desktop` has no implementation since the link daemon was removed, but
  // it is still readable off old sandboxMap rows. Serve those from the hosted
  // provider rather than throwing — the alternative is a 500 on any org that
  // ever ran a desktop sandbox.
  const resolved = kind === "user-desktop" ? "agent-sandbox" : kind;
  return getSandboxProviderByKind(ctx, resolved);
}
