import type { VmMap } from "@decocms/mesh-sdk";
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import { BranchPill } from "./branch-pill";
import { useOptionalChatStream } from "../context";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcpId: string;
  connectionId: string;
  owner: string;
  repo: string;
  vmMap: VmMap | undefined;
  currentBranch: string | null;
  onBranchChange: (branch: string) => void;
  /** Kept in the signature for parity with the previous version even
   *  though the agent pill is gone — callers still pass them and they
   *  may be useful again if we revive a thread-level lock indicator. */
  threadKind: SandboxProviderKind | null;
  threadHarness: HarnessId | null;
}

export function ThreadPills({
  orgId,
  orgSlug,
  userId,
  virtualMcpId,
  connectionId,
  owner,
  repo,
  vmMap,
  currentBranch,
  onBranchChange,
}: Props) {
  const stream = useOptionalChatStream();
  const isActive = (stream?.messages ?? []).length > 0;

  return (
    <div className="flex items-center gap-2 text-xs">
      <BranchPill
        orgId={orgId}
        orgSlug={orgSlug}
        userId={userId}
        virtualMcpId={virtualMcpId}
        connectionId={connectionId}
        owner={owner}
        repo={repo}
        vmMap={vmMap}
        value={currentBranch}
        onChange={onBranchChange}
        locked={isActive}
      />
    </div>
  );
}
