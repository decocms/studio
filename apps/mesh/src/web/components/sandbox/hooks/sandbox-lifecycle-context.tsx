/**
 * Sandbox lifecycle: actions + effects.
 *
 * Owns the SANDBOX_START mutation, the consolidated auto-start effect,
 * the self-heal effect, and user-driven start/stop/restart/retry/resume.
 * Sibling of SandboxEventsProvider; reads `events.notFound` + `events.status`
 * for self-heal and previewState.
 *
 * Pure helpers (selectVmEntry, shouldAutoStart, shouldSelfHeal,
 * computeDrawerStatus) are exported so unit tests can exercise the
 * consolidation logic without crossing the no-mocks line.
 */

import type { PreviewState } from "@/web/components/sandbox/preview/preview-state";
import type { DrawerStatus } from "@/web/components/sandbox/preview/drawer/status-pill";

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

export interface BranchMapEntryLike {
  sandboxHandle: string;
  previewUrl: string | null;
  sandboxProviderKind: string;
}

export function selectVmEntry<T extends BranchMapEntryLike>(
  branchMap: Record<string, T>,
): T | null {
  const entries = Object.values(branchMap);
  if (entries.length === 0) return null;
  return (
    entries.find((e) => e.sandboxProviderKind !== "user-desktop") ?? entries[0]
  );
}

export interface ShouldAutoStartArgs {
  hasActiveGithubRepo: boolean;
  userId: string | null;
  branch: string | null;
  vmEntry: BranchMapEntryLike | null;
  userStopped: boolean;
  isPending: boolean;
  attempted: boolean;
}

export function shouldAutoStart(args: ShouldAutoStartArgs): boolean {
  return (
    args.hasActiveGithubRepo &&
    !!args.userId &&
    !!args.branch &&
    !args.vmEntry &&
    !args.userStopped &&
    !args.isPending &&
    !args.attempted
  );
}

export interface ShouldSelfHealArgs {
  notFound: boolean;
  deadVmId: string | null;
  lastDeadVmId: string | null;
  isPending: boolean;
  userStopped: boolean;
}

export function shouldSelfHeal(args: ShouldSelfHealArgs): boolean {
  return (
    args.notFound &&
    !!args.deadVmId &&
    !args.isPending &&
    !args.userStopped &&
    args.deadVmId !== args.lastDeadVmId
  );
}

export function computeDrawerStatus(state: PreviewState): DrawerStatus {
  switch (state.kind) {
    case "suspended":
      return "suspended";
    case "iframe":
      return "running";
    case "starting":
      return "starting";
  }
}
