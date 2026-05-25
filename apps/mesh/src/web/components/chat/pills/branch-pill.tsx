import type { SandboxMap } from "@decocms/mesh-sdk";
import { GitBranch01 } from "@untitledui/icons";
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
}

export function BranchPill({ locked, value, ...props }: Props) {
  if (locked) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-mono text-muted-foreground"
        title="Fixed for this thread"
      >
        <GitBranch01 size={12} />
        {value ?? "—"}
      </span>
    );
  }
  return <BranchPicker {...props} value={value} />;
}
