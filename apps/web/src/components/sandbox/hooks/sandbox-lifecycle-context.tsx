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

import type {
  PreviewState,
  SandboxStartError,
} from "@/components/sandbox/preview/preview-state";
import type { DrawerStatus } from "@/components/sandbox/preview/drawer/status-pill";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { ClaimFailureReason, ClaimPhase } from "./sandbox-events-context";
import {
  resolveVmEntry,
  selectVmEntry,
  type BranchMapEntryLike,
} from "@decocms/shared/sandbox/select-vm-entry";

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

// Re-exported here for existing importers and the co-located unit tests.
export { resolveVmEntry, selectVmEntry, type BranchMapEntryLike };

export interface ShouldAutoStartArgs {
  hasActiveGithubRepo: boolean;
  userId: string | null;
  branch: string | null;
  vmEntry: BranchMapEntryLike | null;
  userStopped: boolean;
  isPending: boolean;
  attempted: boolean;
  /** Held back until the user confirms opening another member's thread — see
   *  `othersThreadLabel` on the provider. Prevents silently booting a sandbox
   *  on someone else's branch. */
  autoStartBlocked: boolean;
}

export function shouldAutoStart(args: ShouldAutoStartArgs): boolean {
  return (
    args.hasActiveGithubRepo &&
    !!args.userId &&
    !args.vmEntry &&
    !args.userStopped &&
    !args.isPending &&
    !args.attempted &&
    !args.autoStartBlocked
  );
}

export interface ShouldSelfHealArgs {
  notFound: boolean;
  deadVmId: string | null;
  lastDeadVmId: string | null;
  isPending: boolean;
  userStopped: boolean;
  /** Same gate as auto-start: never silently reprovision a sandbox on another
   *  member's branch while the confirmation gate is up. */
  autoStartBlocked: boolean;
}

export function shouldSelfHeal(args: ShouldSelfHealArgs): boolean {
  return (
    args.notFound &&
    !!args.deadVmId &&
    !args.isPending &&
    !args.userStopped &&
    !args.autoStartBlocked &&
    args.deadVmId !== args.lastDeadVmId
  );
}

/** The gate label for an active thread: non-null iff the thread belongs to
 *  another member (its branch — which encodes the owner — or title as a
 *  fallback). Extracted from the layout so the ownership rule is unit-testable:
 *  an inverted comparison here would silently gate the user's own thread. */
export function deriveOthersThreadLabel(args: {
  userId: string | null;
  createdBy: string | null | undefined;
  branch: string | null | undefined;
  title: string | null | undefined;
}): string | null {
  const isOthers =
    !!args.userId && !!args.createdBy && args.createdBy !== args.userId;
  if (!isOthers) return null;
  return args.branch ?? args.title ?? null;
}

/** Whether auto-start (and self-heal) must be held back pending confirmation.
 *  Keyed by thread id, not branch: acknowledging a null-branch thread survives
 *  the server later assigning it a branch (no re-prompt / double-start), and
 *  two different members' threads that collide on a branch name don't share an
 *  acknowledgement. Re-arms when the active thread id changes. */
export function computeOthersThreadGate(args: {
  othersThreadLabel: string | null;
  acknowledgedThreadId: string | null;
  threadId: string | null;
}): { autoStartBlocked: boolean } {
  const acknowledged =
    args.acknowledgedThreadId !== null &&
    args.acknowledgedThreadId === args.threadId;
  return { autoStartBlocked: !!args.othersThreadLabel && !acknowledged };
}

/** Shared SANDBOX_START arg-builder so every call site (auto-start,
 *  self-heal, user-driven start/retry/resume) scopes provisioning to the
 *  locked provider kind identically — a caller that omits it can get
 *  provisioned on the wrong provider. */
export function buildSandboxStartArgs(
  virtualMcpId: string,
  branch: string | null,
  sandboxProviderKind: SandboxProviderKind | null,
): SandboxStartArgs {
  const args: SandboxStartArgs = { virtualMcpId };
  if (branch) args.branch = branch;
  if (sandboxProviderKind) args.sandboxProviderKind = sandboxProviderKind;
  return args;
}

/** How many times to auto-reprovision after a *retryable* terminal claim
 *  failure before giving up and surfacing the errored card. 2 auto-retries =
 *  3 total attempts (the original boot + 2). */
export const MAX_CLAIM_AUTO_RETRIES = 2;

/** Terminal claim failures worth auto-reprovisioning: the failure is on the
 *  infra side and a fresh claim can plausibly land differently.
 *   - `scheduling-timeout` — no node had capacity; Karpenter may have added one.
 *   - `reconciler-error` — transient control-plane hiccup.
 *   - `claim-never-created` — the claim write itself was lost; re-issue it.
 *   - `unknown` — the synthetic "lifecycle watcher ended" (lifecycle.ts): the
 *     watch died, not necessarily the boot; a fresh attempt is worth one shot.
 *  Excluded (retrying fails identically, so surface immediately):
 *   - `image-pull-backoff` — the image is bad/missing.
 *   - `crash-loop-backoff` — the container's own code crashes on start. */
const CLAIM_AUTO_RETRYABLE_REASONS: ReadonlySet<ClaimFailureReason> = new Set([
  "scheduling-timeout",
  "reconciler-error",
  "claim-never-created",
  "unknown",
]);

export function isRetryableClaimFailure(reason: ClaimFailureReason): boolean {
  return CLAIM_AUTO_RETRYABLE_REASONS.has(reason);
}

export interface ShouldAutoRetryClaimArgs {
  /** The terminal failure reason, or null when the phase isn't `failed`. */
  failedReason: ClaimFailureReason | null;
  /** Auto-retries already fired for this boot. */
  attempts: number;
  isPending: boolean;
  userStopped: boolean;
  autoStartBlocked: boolean;
  /** Guard so a single failed episode fires exactly one retry (re-armed when the
   *  phase leaves `failed`). Without it the persistent `failed` phase would
   *  re-fire every render once the mutation settles. */
  alreadyHandled: boolean;
}

export function shouldAutoRetryClaim(args: ShouldAutoRetryClaimArgs): boolean {
  return (
    args.failedReason !== null &&
    isRetryableClaimFailure(args.failedReason) &&
    args.attempts < MAX_CLAIM_AUTO_RETRIES &&
    !args.isPending &&
    !args.userStopped &&
    !args.autoStartBlocked &&
    !args.alreadyHandled
  );
}

/** The bounded auto-retry budget for one boot episode (see shouldAutoRetryClaim). */
export interface ClaimRetryEpisode {
  branch: string | null;
  count: number;
  handled: boolean;
}

const INITIAL_CLAIM_RETRY_EPISODE: ClaimRetryEpisode = {
  branch: null,
  count: 0,
  handled: false,
};

/** Resets the auto-retry budget when the active branch changes. The
 *  lifecycle provider is NOT remounted on a task switch (it lives above
 *  Chat.ActiveTaskProvider), so without this a budget exhausted by one
 *  branch's failed boot would carry over and silently skip auto-retry for
 *  an unrelated branch's fresh boot. Returns `prev` unchanged (same
 *  reference) when the branch hasn't changed, so callers can skip the
 *  state update. */
export function reconcileClaimRetryEpisode(
  prev: ClaimRetryEpisode,
  branch: string | null,
): ClaimRetryEpisode {
  if (prev.branch === branch) return prev;
  return { branch, count: 0, handled: false };
}

/** Terminal SANDBOX_START error to surface (→ `errored` preview state), or null
 *  while still booting. Two independent sources feed the same terminal state:
 *   - a rejected SANDBOX_START mutation (GitHub-not-auth, non-retryable server error);
 *   - a terminal claim-`failed` phase on the SSE lifecycle stream (K8s
 *     scheduling/image-pull failure, or the synthetic "lifecycle watcher ended"
 *     failure from lifecycle.ts).
 *  The phase-failed source never rejects the mutation, so without it
 *  computePreviewState pins to "starting" forever (the infinite-loading bug).
 *  Gate the phase path on no start in flight so an in-progress retry/self-heal
 *  reprovision keeps the booting overlay instead of flashing errored.
 *  `claimRetryExhausted` holds the booting overlay while bounded auto-retry
 *  still has budget for a retryable failure — see shouldAutoRetryClaim. */
export function deriveStartError(args: {
  mutationError: SandboxStartError | null;
  phase: ClaimPhase | null;
  startPending: boolean;
  claimRetryExhausted: boolean;
}): SandboxStartError | null {
  if (args.mutationError) return args.mutationError;
  if (
    args.phase?.kind === "failed" &&
    !args.startPending &&
    args.claimRetryExhausted
  ) {
    return { code: null, message: args.phase.message };
  }
  return null;
}

export function computeDrawerStatus(state: PreviewState): DrawerStatus {
  switch (state.kind) {
    case "suspended":
      return "suspended";
    case "iframe":
      return "running";
    case "starting":
      return "starting";
    case "errored":
      return "errored";
    case "othersThread":
      return "idle";
  }
}

/** A `previewUrl` captured from a SANDBOX_START response, scoped to its claim. */
export interface SeededPreviewUrl {
  /** `virtualMcpId::branch` this URL was claimed for (see `sandboxPreviewKey`). */
  key: string;
  url: string;
}

/**
 * Identity of a claim. `branch` is null on a fresh thread — the server names it
 * in the SANDBOX_START response — so callers seeding from a response pass the
 * response's branch, not the (still null) prop.
 */
export function sandboxPreviewKey(
  virtualMcpId: string | null,
  branch: string | null,
): string {
  return `${virtualMcpId ?? ""}::${branch ?? ""}`;
}

/**
 * The daemon origin to render against.
 *
 * SANDBOX_START returns `previewUrl` at claim time, but `vmEntry` reads it from
 * the entity's `sandboxMap` — a collection query with a 60s staleTime whose only
 * lifecycle-driven invalidation fires when the dev server reports `running`. So
 * the recorded value can lag the live daemon by the entire install/boot, which
 * is exactly the window Fast Preview exists to render in.
 *
 * The recorded entry wins when present (authoritative, survives remounts); the
 * claim response is the fallback. The seed is key-scoped rather than reset on
 * change, so a stale claim can never paint another branch's sandbox.
 */
export function resolvePreviewUrl(args: {
  vmEntry: BranchMapEntryLike | null;
  seeded: SeededPreviewUrl | null;
  key: string;
}): string | null {
  const recorded = args.vmEntry?.previewUrl ?? null;
  if (recorded) return recorded;
  return args.seeded?.key === args.key ? args.seeded.url : null;
}

// ---------------------------------------------------------------------------
// Provider + hook
// ---------------------------------------------------------------------------

import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  parseBranchMap,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@/sdk";
import type { SandboxMap } from "@decocms/shared/sdk/types";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { useChatTask } from "@/components/chat/context";
import {
  sandboxUserStop,
  useSandboxStart,
  type SandboxStartArgs,
  type SandboxStartResult,
} from "./use-sandbox-start";
import { useSandboxEvents } from "./use-sandbox-events";
import { computePreviewState } from "@/components/sandbox/preview/preview-state";
import { decodeSandboxStartError } from "@decocms/shared/sandbox-start-errors";

/**
 * Shared SANDBOX_START `onSuccess`: adopt the branch the server named and record
 * the claim's `previewUrl` (see `resolvePreviewUrl`).
 *
 * Module-level on purpose — every call site passes its dependencies explicitly,
 * so the identity stays stable and the effects that reference it don't re-fire
 * each render (React 19 bans useCallback here).
 */
function recordSandboxStart(args: {
  data: SandboxStartResult | undefined;
  virtualMcpId: string | null;
  branch: string | null;
  setCurrentTaskBranch: (branch: string) => void;
  setSeededPreviewUrl: (seed: SeededPreviewUrl) => void;
}): void {
  const { data, virtualMcpId, branch } = args;
  if (data?.branch && !branch) args.setCurrentTaskBranch(data.branch);
  if (data?.previewUrl) {
    args.setSeededPreviewUrl({
      key: sandboxPreviewKey(virtualMcpId, data.branch ?? branch),
      url: data.previewUrl,
    });
  }
}

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
  /** Confirm opening another member's thread: releases the auto-start gate so
   *  the sandbox boots on that thread's branch. See `othersThreadLabel`. */
  acknowledgeOthersThread: () => void;
  /** The resolved sandbox is another member's (read-only view of their running
   *  sandbox). Its boot progress is unobservable from here — see
   *  `PreviewDisplayInput.foreignSandbox`. */
  foreignSandbox: boolean;
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
  acknowledgeOthersThread: () => {},
  foreignSandbox: false,
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
  sandboxProviderKind,
  othersThreadLabel,
  othersThreadId,
  foreignSandbox = false,
  children,
}: {
  virtualMcpId: string | null;
  branch: string | null;
  userId: string | null;
  hasActiveGithubRepo: boolean;
  sandboxMap: SandboxMap | undefined;
  /** Resolved provider kind from the active thread (locked) or live mode pick
   *  (unlocked). When non-null, entry selection and SANDBOX_START are scoped to
   *  this kind so the preview never silently shows a different-provider sibling. */
  sandboxProviderKind: SandboxProviderKind | null;
  /** Non-null when the active thread belongs to another member: label to show
   *  in the confirmation gate (its branch, or title). While set and not yet
   *  acknowledged, auto-start is held back so we never silently boot a sandbox
   *  on someone else's branch. Null on the user's own thread. */
  othersThreadLabel: string | null;
  /** Active thread id — the acknowledgement key (see computeOthersThreadGate). */
  othersThreadId: string | null;
  /** The `sandboxMap` entry for this branch is another member's, grafted in so a
   *  read-only viewer resolves their running sandbox (see `VmEventsBridge`).
   *  Forwarded to the preview display, whose progress gate can never clear for
   *  it. Defaults false (own sandbox). */
  foreignSandbox?: boolean;
  children: ReactNode;
}) {
  const { org } = useProjectContext();
  const { setCurrentTaskBranch } = useChatTask();
  const events = useSandboxEvents();
  const queryClient = useQueryClient();

  // Confirmation gate for another member's thread (see computeOthersThreadGate).
  const [acknowledgedThreadId, setAcknowledgedThreadId] = useState<
    string | null
  >(null);
  const { autoStartBlocked } = computeOthersThreadGate({
    othersThreadLabel,
    acknowledgedThreadId,
    threadId: othersThreadId,
  });

  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useSandboxStart(mcpClient);
  // Destructure mutate/reset so they're stable references for effect deps.
  const { mutate: startVmMutate, reset: startVmReset } = startVm;

  // `previewUrl` straight off the claim, until the entity query catches up.
  // Lets Fast Preview render while the dev server is still installing — see
  // resolvePreviewUrl.
  const [seededPreviewUrl, setSeededPreviewUrl] =
    useState<SeededPreviewUrl | null>(null);

  // Branch-keyed dedup (replaces both legacy taskId-keyed (preview.tsx) and
  // branch-keyed (VmEventsBridge) dedup refs).
  const autoStartAttemptedForBranchRef = useRef<Set<string>>(new Set());
  const reprovisionedForVmIdRef = useRef<string | null>(null);
  // Bounded auto-retry of retryable terminal claim failures (see
  // shouldAutoRetryClaim). `count` is the budget for this boot; `handled`
  // fires exactly one retry per failed episode (re-armed when phase leaves
  // `failed`). Both reset on a user-driven retry(), and reconciled against
  // the active branch below (see reconcileClaimRetryEpisode) since this
  // provider outlives a task switch.
  const [claimRetryEpisodeState, setClaimRetryEpisodeState] = useState(
    INITIAL_CLAIM_RETRY_EPISODE,
  );
  const claimRetryEpisode = reconcileClaimRetryEpisode(
    claimRetryEpisodeState,
    branch,
  );
  if (claimRetryEpisode !== claimRetryEpisodeState) {
    setClaimRetryEpisodeState(claimRetryEpisode);
  }

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
  // When a provider kind is known (locked thread or live mode pick), the
  // matching entry wins; with no entry for that kind (or no kind at all) fall
  // back to whatever is serving the branch. See resolveVmEntry.
  const vmEntry = resolveVmEntry(branchMap, sandboxProviderKind);
  const failedPhase = events.phase?.kind === "failed" ? events.phase : null;
  const previewUrl = resolvePreviewUrl({
    vmEntry,
    // SANDBOX_START returns a previewUrl at claim time, before the pod is
    // known-healthy. On a terminal claim failure that handle never came up, so
    // drop the seed: computePreviewState reads any previewUrl as "the sandbox
    // is live" and would paint a dead iframe over the errored card. A recorded
    // vmEntry is different — it means the sandbox did serve at some point, and
    // the existing rule (a failed restart shouldn't blank a working preview)
    // still applies.
    seeded: failedPhase ? null : seededPreviewUrl,
    key: sandboxPreviewKey(virtualMcpId, branch),
  });
  const userStopped =
    !!virtualMcpId &&
    !!branch &&
    sandboxUserStop.isStopped(virtualMcpId, branch);
  const appPaused = events.status.state === "paused";
  // A retryable claim failure keeps the booting overlay (deriveStartError
  // returns null) while bounded auto-retry still has budget; once exhausted (or
  // for a non-retryable reason) it surfaces the errored card.
  const claimRetryExhausted =
    !failedPhase ||
    !isRetryableClaimFailure(failedPhase.reason) ||
    claimRetryEpisode.count >= MAX_CLAIM_AUTO_RETRIES;
  const startError = deriveStartError({
    mutationError:
      startVm.isError && startVm.error
        ? decodeSandboxStartError(startVm.error.message)
        : null,
    phase: events.phase,
    startPending: startVm.isPending,
    claimRetryExhausted,
  });
  const previewState = computePreviewState({
    previewUrl,
    appPaused,
    userStopped,
    startError,
    othersThreadGate:
      autoStartBlocked && othersThreadLabel
        ? { label: othersThreadLabel }
        : null,
  });
  const status = computeDrawerStatus(previewState);

  // Auto-start (consolidated): "arrive at a branch with no VM, no user-stop,
  // not already started → fire SANDBOX_START once for this branch."
  // Branch-keyed, not taskId-keyed: that matches useSandboxStart's own
  // dedup and avoids resurrecting a user-killed VM across task switches.
  // Dedup key: use branch string, or "" for the no-branch (pre-lock) case so a
  // single auto-start fires even before the server assigns a branch.
  const autoStartDedupKey = branch ?? "";
  const attempted =
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read-only dedup probe; mutation happens inside effect after add()
    autoStartAttemptedForBranchRef.current.has(autoStartDedupKey);
  const autoStartEligible = shouldAutoStart({
    hasActiveGithubRepo,
    userId,
    branch,
    vmEntry,
    userStopped,
    isPending: startVm.isPending,
    attempted,
    autoStartBlocked,
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- bridges external state into a one-shot mutation; no render-time equivalent
  useEffect(() => {
    if (!autoStartEligible || !virtualMcpId) return;
    autoStartAttemptedForBranchRef.current.add(autoStartDedupKey);
    const args = buildSandboxStartArgs(
      virtualMcpId,
      branch,
      sandboxProviderKind,
    );
    startVmMutate(args, {
      onSuccess: (data) => {
        recordSandboxStart({
          data,
          virtualMcpId,
          branch,
          setCurrentTaskBranch,
          setSeededPreviewUrl,
        });
      },
      onError: (err) => {
        console.error("[sandbox-lifecycle] auto-start failed:", err);
      },
    });
  }, [
    autoStartEligible,
    autoStartDedupKey,
    branch,
    virtualMcpId,
    sandboxProviderKind,
    startVmMutate,
    setCurrentTaskBranch,
    setSeededPreviewUrl,
  ]);

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
    autoStartBlocked,
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot reprovision trigger gated on notFound→deadVmId
  useEffect(() => {
    if (!selfHealEligible || !deadVmId || !virtualMcpId) return;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- record dead handle to dedup repeat 404s
    reprovisionedForVmIdRef.current = deadVmId;
    const args = buildSandboxStartArgs(
      virtualMcpId,
      branch,
      sandboxProviderKind,
    );
    startVmMutate(args, {
      onSuccess: (data) => {
        recordSandboxStart({
          data,
          virtualMcpId,
          branch,
          setCurrentTaskBranch,
          setSeededPreviewUrl,
        });
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
    sandboxProviderKind,
    startVmMutate,
    setCurrentTaskBranch,
    setSeededPreviewUrl,
  ]);

  // Auto-retry: a *retryable* terminal claim failure (capacity/scheduling/
  // control-plane hiccup — not a bad image or crash-loop) reprovisions in place
  // a bounded number of times before falling through to the errored card, so
  // the common transient-infra failure self-heals without a user click.
  const claimRetryEligible = shouldAutoRetryClaim({
    failedReason: failedPhase?.reason ?? null,
    attempts: claimRetryEpisode.count,
    isPending: startVm.isPending,
    userStopped,
    autoStartBlocked,
    alreadyHandled: claimRetryEpisode.handled,
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- bridges the SSE failed phase into a one-shot bounded reprovision
  useEffect(() => {
    if (!failedPhase) {
      // Left the failed state (new claim in progress / ready) → re-arm so the
      // next distinct failure episode can fire its own retry. Bails out (same
      // reference) when already re-armed, so this doesn't cause a render loop.
      setClaimRetryEpisodeState((prev) =>
        prev.handled ? { ...prev, handled: false } : prev,
      );
      return;
    }
    if (!claimRetryEligible || !virtualMcpId) return;
    // Mark this episode handled (fires exactly once) and consume one retry
    // from this branch's boot budget.
    setClaimRetryEpisodeState((prev) => ({
      ...prev,
      handled: true,
      count: prev.count + 1,
    }));
    const args = buildSandboxStartArgs(
      virtualMcpId,
      branch,
      sandboxProviderKind,
    );
    startVmMutate(args, {
      onSuccess: (data) => {
        recordSandboxStart({
          data,
          virtualMcpId,
          branch,
          setCurrentTaskBranch,
          setSeededPreviewUrl,
        });
      },
      onError: (err) => {
        console.error("[sandbox-lifecycle] claim auto-retry failed:", err);
      },
    });
  }, [
    failedPhase,
    claimRetryEligible,
    virtualMcpId,
    branch,
    sandboxProviderKind,
    startVmMutate,
    setCurrentTaskBranch,
    setSeededPreviewUrl,
  ]);

  // User-driven actions.
  const start = () => {
    if (!virtualMcpId) return;
    const args = buildSandboxStartArgs(
      virtualMcpId,
      branch,
      sandboxProviderKind,
    );
    startVmMutate(args, {
      onSuccess: (data) => {
        recordSandboxStart({
          data,
          virtualMcpId,
          branch,
          setCurrentTaskBranch,
          setSeededPreviewUrl,
        });
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
    // Fresh auto-retry budget for the user-driven attempt.
    setClaimRetryEpisodeState({ branch, count: 0, handled: false });
    startVmReset();
    start();
  };
  const resume = retry;

  // Confirm opening another member's thread → release the gate. Auto-start
  // becomes eligible on the next render and fires SANDBOX_START for this branch.
  const acknowledgeOthersThread = () => setAcknowledgedThreadId(othersThreadId);

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
    acknowledgeOthersThread,
    foreignSandbox,
  };

  return (
    <SandboxLifecycleContext value={value}>{children}</SandboxLifecycleContext>
  );
}
