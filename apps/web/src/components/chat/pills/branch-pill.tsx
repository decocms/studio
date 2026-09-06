import type { SandboxMap } from "@/sdk";
import { BranchPicker } from "../../thread/github/branch-picker";
import { BranchPickerLegacy } from "../../thread/github/branch-picker-legacy";

interface Props {
  /** Draft & Releases mode: on → the releases switcher; off → the classic
   *  branch/PR picker. */
  draftsMode: boolean;
  virtualMcpId: string;
  userLabel: string | null | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  locked: boolean;
  placement?: "chat" | "header";
  /** Drafts-mode only: production branch shown as "Produção". */
  baseBranch?: string | null;
  /** Classic-picker only: repo scope for listing branches/PRs. */
  orgId: string;
  orgSlug: string;
  userId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
}

/** Routes to the drafts switcher or the classic branch/PR picker by the
 *  per-agent flag. A `locked` chat has a fixed branch, so any pick/create opens
 *  a new chat on it instead of switching (`spawnsNewChat`). */
export function BranchPill({
  draftsMode,
  locked,
  placement,
  value,
  virtualMcpId,
  userLabel,
  baseBranch,
  onChange,
  onCreateBranch,
  orgId,
  orgSlug,
  userId,
  connectionId,
  owner,
  repo,
  sandboxMap,
}: Props) {
  if (draftsMode) {
    return (
      <BranchPicker
        virtualMcpId={virtualMcpId}
        userLabel={userLabel}
        value={value}
        baseBranch={baseBranch}
        orgId={orgId}
        orgSlug={orgSlug}
        userId={userId}
        connectionId={connectionId}
        owner={owner}
        repo={repo}
        sandboxMap={sandboxMap}
        onChange={onChange}
        onCreateBranch={onCreateBranch}
        spawnsNewChat={locked}
        placement={placement}
      />
    );
  }
  return (
    <BranchPickerLegacy
      orgId={orgId}
      orgSlug={orgSlug}
      userId={userId}
      userLabel={userLabel}
      virtualMcpId={virtualMcpId}
      connectionId={connectionId}
      owner={owner}
      repo={repo}
      sandboxMap={sandboxMap}
      value={value}
      onChange={onChange}
      onCreateBranch={onCreateBranch}
      spawnsNewChat={locked}
      placement={placement}
    />
  );
}
