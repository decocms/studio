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
  const [first] = entries;
  if (!first) return null;
  return entries.find((e) => e.sandboxProviderKind !== "user-desktop") ?? first;
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

// ---------------------------------------------------------------------------
// Provider + hook
// ---------------------------------------------------------------------------

import { createContext, use, useEffect, useRef, type ReactNode } from "react";
import {
  parseBranchMap,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { SandboxMap } from "@decocms/mesh-sdk/types";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import { useChatTask } from "@/web/components/chat/context";
import {
  sandboxUserStop,
  useSandboxStart,
  type SandboxStartArgs,
} from "./use-sandbox-start";
import { useSandboxEvents } from "./use-sandbox-events";
import { computePreviewState } from "@/web/components/sandbox/preview/preview-state";

export interface SandboxLifecycleValue {
  branch: string | null;
  previewState: PreviewState;
  status: DrawerStatus;
  vmEntry: BranchMapEntryLike | null;
  previewUrl: string | null;
  userStopped: boolean;
  start: () => void;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  retry: () => void;
  resume: () => void;
}

const DEFAULT_VALUE: SandboxLifecycleValue = {
  branch: null,
  previewState: { kind: "starting" },
  status: "idle",
  vmEntry: null,
  previewUrl: null,
  userStopped: false,
  start: () => {},
  stop: async () => {},
  restart: async () => {},
  retry: () => {},
  resume: () => {},
};

const SandboxLifecycleContext =
  createContext<SandboxLifecycleValue>(DEFAULT_VALUE);

export function useSandboxLifecycle(): SandboxLifecycleValue {
  return use(SandboxLifecycleContext);
}

export function SandboxLifecycleProvider({
  virtualMcpId,
  branch,
  userId,
  hasActiveGithubRepo,
  sandboxMap,
  children,
}: {
  virtualMcpId: string | null;
  branch: string | null;
  userId: string | null;
  hasActiveGithubRepo: boolean;
  sandboxMap: SandboxMap | undefined;
  children: ReactNode;
}) {
  const { org } = useProjectContext();
  const { setCurrentTaskBranch } = useChatTask();
  const events = useSandboxEvents();
  const queryClient = useQueryClient();

  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useSandboxStart(mcpClient);
  // Destructure mutate/reset so they're stable references for effect deps.
  const { mutate: startVmMutate, reset: startVmReset } = startVm;

  // Branch-keyed dedup (replaces both legacy taskId-keyed (preview.tsx) and
  // branch-keyed (VmEventsBridge) dedup refs).
  const autoStartAttemptedForBranchRef = useRef<Set<string>>(new Set());
  const reprovisionedForVmIdRef = useRef<string | null>(null);

  // Derived values, recomputed each render.
  // Cast: parseBranchMap returns SandboxRecord where sandboxProviderKind is
  // optional, but BranchMapEntryLike requires it as string. selectVmEntry
  // only filters on the value (undefined !== "user-desktop" still works) so
  // the cast is safe in practice.
  const branchMap =
    userId && branch
      ? (parseBranchMap(sandboxMap?.[userId]?.[branch]) as Record<
          string,
          BranchMapEntryLike
        >)
      : {};
  const vmEntry = selectVmEntry(branchMap);
  const previewUrl = vmEntry?.previewUrl ?? null;
  const userStopped =
    !!virtualMcpId &&
    !!branch &&
    sandboxUserStop.isStopped(virtualMcpId, branch);
  const appPaused = events.status.state === "paused";
  const previewState = computePreviewState({
    previewUrl,
    appPaused,
    userStopped,
  });
  const status = computeDrawerStatus(previewState);

  // Auto-start (consolidated): "arrive at a branch with no VM, no user-stop,
  // not already started → fire SANDBOX_START once for this branch."
  // Branch-keyed, not taskId-keyed: that matches useSandboxStart's own
  // dedup and avoids resurrecting a user-killed VM across task switches.
  const attempted =
    branch !== null &&
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read-only dedup probe; mutation happens inside effect after add()
    autoStartAttemptedForBranchRef.current.has(branch);
  const autoStartEligible = shouldAutoStart({
    hasActiveGithubRepo,
    userId,
    branch,
    vmEntry,
    userStopped,
    isPending: startVm.isPending,
    attempted,
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- bridges external state into a one-shot mutation; no render-time equivalent
  useEffect(() => {
    if (!autoStartEligible || !branch || !virtualMcpId) return;
    autoStartAttemptedForBranchRef.current.add(branch);
    // Auto-start is gated on `!!branch` via shouldAutoStart, so the
    // server-picks-a-branch flow (the onSuccess in self-heal + user start)
    // is structurally unreachable here. No onSuccess needed.
    const args: SandboxStartArgs = { virtualMcpId, branch };
    startVmMutate(args, {
      onError: (err) => {
        console.error("[sandbox-lifecycle] auto-start failed:", err);
      },
    });
  }, [autoStartEligible, branch, virtualMcpId, startVmMutate]);

  // Self-heal: SSE emits `gone` → reprovision via SANDBOX_START. Dedup by
  // dead handle so we don't loop on repeat 404s; a new dead handle is fine.
  const deadVmId = events.notFound ? (vmEntry?.sandboxHandle ?? null) : null;
  const selfHealEligible = shouldSelfHeal({
    notFound: events.notFound,
    deadVmId,
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read-only dedup probe; recorded inside effect after firing
    lastDeadVmId: reprovisionedForVmIdRef.current,
    isPending: startVm.isPending,
    userStopped,
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot reprovision trigger gated on notFound→deadVmId
  useEffect(() => {
    if (!selfHealEligible || !deadVmId || !virtualMcpId) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- record dead handle to dedup repeat 404s
    reprovisionedForVmIdRef.current = deadVmId;
    const args: SandboxStartArgs = { virtualMcpId };
    if (branch) args.branch = branch;
    startVmMutate(args, {
      onSuccess: (data) => {
        if (data?.branch && !branch) setCurrentTaskBranch(data.branch);
      },
      onError: (err) => {
        console.error("[sandbox-lifecycle] self-heal failed:", err);
      },
    });
  }, [
    selfHealEligible,
    deadVmId,
    virtualMcpId,
    branch,
    startVmMutate,
    setCurrentTaskBranch,
  ]);

  // User-driven actions.
  const start = () => {
    if (!virtualMcpId) return;
    const args: SandboxStartArgs = { virtualMcpId };
    if (branch) args.branch = branch;
    startVmMutate(args, {
      onSuccess: (data) => {
        if (data?.branch && !branch) setCurrentTaskBranch(data.branch);
      },
      onError: (err) => {
        console.error("[sandbox-lifecycle] user start failed:", err);
      },
    });
  };

  const stop = async () => {
    if (!virtualMcpId || !branch) return;
    const kindToStop = vmEntry?.sandboxProviderKind;
    if (!kindToStop) return;
    sandboxUserStop.mark(virtualMcpId, branch);
    try {
      await mcpClient.callTool({
        name: "SANDBOX_DELETE",
        arguments: {
          virtualMcpId,
          branch,
          sandboxProviderKind: kindToStop,
        },
      });
    } catch {
      // Best effort
    }
    invalidateVirtualMcpQueries(queryClient);
  };

  const restart = async () => {
    await stop();
    start();
  };

  // Retry / Resume: clear dedup refs and re-fire start. The drawer toolbar
  // calls onRetry for `errored` and onResume for `suspended`; both reduce
  // to the same operation in the provider.
  const retry = () => {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- reset dedup so a fresh start can fire
    autoStartAttemptedForBranchRef.current = new Set();
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- reset dedup so self-heal can fire on next gone
    reprovisionedForVmIdRef.current = null;
    startVmReset();
    start();
  };
  const resume = retry;

  // Value is recomputed each render; React 19 Compiler handles memoization.
  const value: SandboxLifecycleValue = {
    branch,
    previewState,
    status,
    vmEntry,
    previewUrl,
    userStopped,
    start,
    stop,
    restart,
    retry,
    resume,
  };

  return (
    <SandboxLifecycleContext value={value}>{children}</SandboxLifecycleContext>
  );
}
