import {
  useVmEvents,
  type BranchStatus,
} from "@/web/components/vm/hooks/use-vm-events";

/**
 * useBranchStatus — returns the VM daemon's latest branch-status snapshot
 * as tracked by the shared VmEventsProvider. Returns null when the VM is
 * not connected.
 *
 * The previous version opened its own EventSource per call; the provider
 * model means consumers share one connection.
 */
export function useBranchStatus(): BranchStatus | null {
  return useVmEvents().branchStatus;
}
