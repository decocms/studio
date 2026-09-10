import type { SandboxMap } from "@/sdk";
import type { RepoToolTarget } from "@/lib/github-repo.ts";
import { BranchPicker } from "../../thread/github/branch-picker";

interface Props {
  virtualMcpId: string;
  userLabel: string | null | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  locked: boolean;
  placement?: "chat" | "header";
  /** Production branch shown as "Produção" in the releases switcher. */
  baseBranch?: string | null;
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
  userLabel,
  baseBranch,
  onChange,
  onCreateBranch,
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
      userLabel={userLabel}
      value={value}
      baseBranch={baseBranch}
      orgId={orgId}
      orgSlug={orgSlug}
      userId={userId}
      target={target}
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
