import type { SandboxMap } from "@/sdk";
import type { RepoToolTarget } from "@/lib/repository-binding.ts";
import { BranchPicker } from "../../thread/repository/branch-picker";

interface Props {
  virtualMcpId: string;
  /** A Blocks v8 site: Localhost instead of main's Local tunnel. */
  isV8?: boolean;
  userLabel: string | null | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  /** Adopting a branch/PR opens a sandbox coding session on it. */
  onAdoptBranch?: (branch: string) => void;
  locked: boolean;
  placement?: "chat" | "header";
  /** Production branch shown as "Produção" in the releases switcher. */
  baseBranch?: string | null;
  /** The base branch holds a hosted v8 editor draft (see BranchPicker). */
  baseIsDraft?: boolean;
  /** Repo scope for listing branches/PRs. */
  orgId: string;
  orgSlug: string;
  userId: string;
  target: RepoToolTarget;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
}

/** The releases switcher. A `locked` chat has a fixed branch, so any pick/create
 *  opens a new chat on it instead of switching (`spawnsNewChat`). */
export function BranchPill({
  locked,
  placement,
  value,
  virtualMcpId,
  isV8,
  userLabel,
  baseBranch,
  baseIsDraft,
  onChange,
  onCreateBranch,
  onAdoptBranch,
  orgId,
  orgSlug,
  userId,
  target,
  owner,
  repo,
  sandboxMap,
}: Props) {
  return (
    <BranchPicker
      virtualMcpId={virtualMcpId}
      isV8={isV8}
      userLabel={userLabel}
      value={value}
      baseBranch={baseBranch}
      baseIsDraft={baseIsDraft}
      orgId={orgId}
      orgSlug={orgSlug}
      userId={userId}
      target={target}
      owner={owner}
      repo={repo}
      sandboxMap={sandboxMap}
      onChange={onChange}
      onCreateBranch={onCreateBranch}
      onAdoptBranch={onAdoptBranch}
      spawnsNewChat={locked}
      placement={placement}
    />
  );
}
