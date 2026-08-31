import type { SandboxMap } from "@/sdk";
import { BranchPicker } from "../../thread/github/branch-picker";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  userLabel: string | null | undefined;
  virtualMcpId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  locked: boolean;
  placement?: "chat" | "header";
}

/** Thin wrapper over `BranchPicker`: a `locked` chat has a fixed branch, so any
 *  pick/create opens a new chat on it instead of switching (`spawnsNewChat`). */
export function BranchPill({ locked, placement, value, ...props }: Props) {
  return (
    <BranchPicker
      {...props}
      value={value}
      placement={placement}
      spawnsNewChat={locked}
    />
  );
}
