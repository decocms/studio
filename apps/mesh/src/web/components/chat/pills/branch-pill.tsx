import type { SandboxMap } from "@decocms/mesh-sdk";
import { BranchPicker } from "../../thread/github/branch-picker";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcpId: string;
  connectionId: string | null;
  owner: string;
  repo: string;
  sandboxMap: SandboxMap | undefined;
  value: string | null | undefined;
  onChange: (branch: string) => void;
  locked: boolean;
  compact?: boolean;
}

/**
 * Thin wrapper over `BranchPicker` that maps the chat-level `locked`
 * flag onto the picker's `disabled` prop. The picker still renders its
 * Button + Tooltip when disabled — the user just can't open the
 * popover. The compact + tooltip treatment is delegated downstream.
 */
export function BranchPill({ locked, ...props }: Props) {
  return <BranchPicker {...props} disabled={locked} />;
}
