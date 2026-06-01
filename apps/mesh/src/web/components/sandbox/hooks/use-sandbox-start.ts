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
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import { callSandboxTool } from "./call-sandbox-tool";

const SANDBOX_START_MUTATION_KEY = ["SANDBOX_START"] as const;

interface MinimalMcpClient {
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
}

export interface SandboxStartArgs {
  virtualMcpId: string;
  /** Optional — SANDBOX_START generates one when omitted. */
  branch?: string;
  /**
   * Optional explicit sandbox provider kind. When omitted the server picks
   * via resolveDefaultSandboxProviderKind (link-online ⇒ user-desktop, else
   * the env kind). Used by the v2 RunnerPill to materialize a specific kind.
   */
  sandboxProviderKind?: "cluster" | "user-desktop";
}

export interface SandboxStartResult {
  previewUrl: string | null;
  sandboxHandle: string;
  branch: string;
  isNewVm: boolean;
  sandboxProviderKind?: "cluster" | "user-desktop";
}

const inflightStarts = new Map<string, Promise<SandboxStartResult>>();
const startKey = (args: SandboxStartArgs) =>
  `${args.virtualMcpId}::${args.branch ?? ""}`;

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

export function useSandboxStart(client: MinimalMcpClient) {
  const queryClient = useQueryClient();
  return useMutation<SandboxStartResult, Error, SandboxStartArgs>({
    mutationKey: SANDBOX_START_MUTATION_KEY,
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
