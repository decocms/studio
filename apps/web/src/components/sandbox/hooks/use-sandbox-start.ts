/**
 * Single SANDBOX_START mutation shared by preview + env + layout surfaces.
 * Routing through callSandboxTool surfaces MCP-protocol errors uniformly.
 * Cross-component dedup via module-level in-flight map: concurrent callers
 * for the same (virtualMcpId, branch) attach to one upstream request, so
 * rapid mounts on navigation can't stack 10–30s container-create calls.
 */

import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import type {
  StudioToolInput,
  StudioToolOutput,
} from "@decocms/shared/tools/tool-io";
import { invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { callSandboxTool } from "./call-sandbox-tool";

const SANDBOX_START_MUTATION_KEY = ["SANDBOX_START"] as const;

interface MinimalMcpClient {
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
}

export type SandboxStartArgs = StudioToolInput<"SANDBOX_START">;

type HostedSandboxStartResult = StudioToolOutput<"SANDBOX_START">;

/**
 * The native local API intercepts SANDBOX_START before it reaches the hosted
 * API and returns the same payload for its user-desktop runtime. Keep that
 * local override explicit instead of widening the hosted wire contract.
 */
type NativeSandboxStartResult = Omit<
  HostedSandboxStartResult,
  "sandboxProviderKind"
> & {
  sandboxProviderKind: "user-desktop";
};

export type SandboxStartResult =
  | HostedSandboxStartResult
  | NativeSandboxStartResult;

const inflightStarts = new Map<string, Promise<SandboxStartResult>>();
const startKey = (args: SandboxStartArgs) =>
  `${args.virtualMcpId}::${args.branch ?? ""}`;

// Concurrency-transient failures the server tags with a "retry shortly" marker
// (lifecycle-transition-in-progress + advisory-lock-busy in
// agent-sandbox-sessions.ts / *-runner-state.ts). These resolve within a beat
// once the racing lifecycle transition finishes, so we retry them in-place
// rather than surfacing an error the user would have to clear by hand. The
// mutation stays `isPending` across retries, so the booting overlay holds
// instead of flipping to the error state.
export const isRetryableSandboxStartError = (error: Error) =>
  error.message.includes("retry shortly");

// Tracks (virtualMcpId, branch) pairs explicitly stopped by the user.
// Prevents self-heal from restarting a sandbox the user just stopped: the SSE
// "gone" event can race the sandboxMap query refetch and arrive while vmEntry
// is still stale in the cache, making deadVmId non-null and triggering
// an unwanted self-heal. Cleared on any SANDBOX_START so normal auto-start
// resumes after an explicit user restart.
const userStoppedSandboxes = new Set<string>();

export const sandboxUserStop = {
  mark: (virtualMcpId: string, branch: string) =>
    userStoppedSandboxes.add(`${virtualMcpId}::${branch}`),
  clear: (virtualMcpId: string, branch: string) =>
    userStoppedSandboxes.delete(`${virtualMcpId}::${branch}`),
  isStopped: (virtualMcpId: string, branch: string) =>
    userStoppedSandboxes.has(`${virtualMcpId}::${branch}`),
};

export function useSandboxStart(
  client: MinimalMcpClient,
  opts?: {
    /** Ran after every successful start, whichever call site fired it. Lives
     *  here rather than in each caller's per-call `onSuccess` so it can't be
     *  forgotten by a new call site — and so it never becomes an effect
     *  dependency (mutation options are re-read per render; effect deps are not). */
    onStarted?: () => void;
  },
) {
  const queryClient = useQueryClient();
  return useMutation<SandboxStartResult, Error, SandboxStartArgs>({
    mutationKey: SANDBOX_START_MUTATION_KEY,
    // Auto-recover from transient lifecycle/lock contention without a refresh.
    retry: (count, error) => isRetryableSandboxStartError(error) && count < 6,
    retryDelay: (attempt) =>
      exponentialBackoffWithJitter(5000, 500, attempt, 2, 0),
    mutationFn: async (args) => {
      if (args.branch) sandboxUserStop.clear(args.virtualMcpId, args.branch);
      const key = startKey(args);
      const existing = inflightStarts.get(key);
      if (existing) return existing;
      const promise = (async () => {
        const result = await callSandboxTool(
          client,
          "SANDBOX_START",
          args as unknown as Record<string, unknown>,
        );
        return result.structuredContent as SandboxStartResult;
      })();
      inflightStarts.set(key, promise);
      try {
        return await promise;
      } finally {
        if (inflightStarts.get(key) === promise) inflightStarts.delete(key);
      }
    },
    // Per-call onSuccess (via `mutate(args, { onSuccess })`) runs AFTER this.
    onSuccess: () => {
      invalidateVirtualMcpQueries(queryClient);
      opts?.onStarted?.();
    },
  });
}

/**
 * Cross-component inflight signal for SANDBOX_START on a specific (vmcp, branch).
 * Each `useSandboxStart()` caller owns its own `useMutation` instance, so a
 * component's local `isPending` only reflects mutations it initiated. The
 * layout auto-starts the sandbox while other surfaces (preview, env) render in
 * parallel — those surfaces need to know the auto-start is in flight so they
 * don't fall through to the idle/empty state. `useIsMutating` observes the
 * whole QueryClient; the predicate scopes by the mutation's variables.
 */
export function useIsSandboxStartPending(
  virtualMcpId: string | undefined,
  branch: string | undefined,
): boolean {
  const count = useIsMutating({
    mutationKey: SANDBOX_START_MUTATION_KEY,
    predicate: (mutation) => {
      if (!virtualMcpId) return false;
      const vars = mutation.state.variables as SandboxStartArgs | undefined;
      if (!vars || vars.virtualMcpId !== virtualMcpId) return false;
      return (vars.branch ?? "") === (branch ?? "");
    },
  });
  return count > 0;
}
