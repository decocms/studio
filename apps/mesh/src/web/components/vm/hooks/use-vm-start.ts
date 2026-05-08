/**
 * Single VM_START mutation shared by preview + env + layout surfaces.
 * Routing through callVmTool surfaces MCP-protocol errors uniformly.
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
import { callVmTool } from "./call-vm-tool";

const VM_START_MUTATION_KEY = ["VM_START"] as const;

interface MinimalMcpClient {
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
}

export interface VmStartArgs {
  virtualMcpId: string;
  /** Optional — VM_START generates one when omitted. */
  branch?: string;
}

export interface VmStartResult {
  previewUrl: string | null;
  vmId: string;
  branch: string;
  isNewVm: boolean;
  runnerKind?: "host" | "docker" | "freestyle" | "agent-sandbox";
}

const inflightStarts = new Map<string, Promise<VmStartResult>>();
const startKey = (args: VmStartArgs) =>
  `${args.virtualMcpId}::${args.branch ?? ""}`;

// Tracks (virtualMcpId, branch) pairs explicitly stopped by the user.
// Prevents self-heal from restarting a VM the user just stopped: the SSE
// "gone" event can race the vmMap query refetch and arrive while vmEntry
// is still stale in the cache, making deadVmId non-null and triggering
// an unwanted self-heal. Cleared on any VM_START so normal auto-start
// resumes after an explicit user restart.
const userStoppedVms = new Set<string>();

export const vmUserStop = {
  mark: (virtualMcpId: string, branch: string) =>
    userStoppedVms.add(`${virtualMcpId}::${branch}`),
  clear: (virtualMcpId: string, branch: string) =>
    userStoppedVms.delete(`${virtualMcpId}::${branch}`),
  isStopped: (virtualMcpId: string, branch: string) =>
    userStoppedVms.has(`${virtualMcpId}::${branch}`),
};

export function useVmStart(client: MinimalMcpClient) {
  const queryClient = useQueryClient();
  return useMutation<VmStartResult, Error, VmStartArgs>({
    mutationKey: VM_START_MUTATION_KEY,
    mutationFn: async (args) => {
      if (args.branch) vmUserStop.clear(args.virtualMcpId, args.branch);
      const key = startKey(args);
      const existing = inflightStarts.get(key);
      if (existing) return existing;
      const promise = (async () => {
        const result = await callVmTool(
          client,
          "VM_START",
          args as unknown as Record<string, unknown>,
        );
        return result.structuredContent as VmStartResult;
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
 * Cross-component inflight signal for VM_START on a specific (vmcp, branch).
 * Each `useVmStart()` caller owns its own `useMutation` instance, so a
 * component's local `isPending` only reflects mutations it initiated. The
 * layout auto-starts the VM while other surfaces (preview, env) render in
 * parallel — those surfaces need to know the auto-start is in flight so they
 * don't fall through to the idle/empty state. `useIsMutating` observes the
 * whole QueryClient; the predicate scopes by the mutation's variables.
 */
export function useIsVmStartPending(
  virtualMcpId: string | undefined,
  branch: string | undefined,
): boolean {
  const count = useIsMutating({
    mutationKey: VM_START_MUTATION_KEY,
    predicate: (mutation) => {
      if (!virtualMcpId) return false;
      const vars = mutation.state.variables as VmStartArgs | undefined;
      if (!vars || vars.virtualMcpId !== virtualMcpId) return false;
      return (vars.branch ?? "") === (branch ?? "");
    },
  });
  return count > 0;
}
