import type { Release } from "@decocms/shared/sdk/types";
import { BranchPicker } from "@/components/thread/github/branch-picker";
import { setStubReleases } from "./stubs/use-releases.ts";

const COLORS = ["orange", "violet", "blue", "pink", "amber", "teal"];

/** "Draft 1..N", plus a couple of renamed ones so search has something to tell apart. */
function drafts(count: number): Release[] {
  const named = ["Black Friday hero", "Natal 2026"];
  return Array.from({ length: count }, (_, i) => ({
    branch: `draft-${i + 1}`,
    name: named[i] ?? `Draft ${i + 1}`,
    color: COLORS[i % COLORS.length]!,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  }));
}

/** The branch picker over an arbitrary number of drafts. */
export function BranchPickerHarness({ count = 30 }: { count?: number }) {
  setStubReleases(drafts(count));
  return (
    <div className="flex h-screen items-start justify-start bg-background p-4">
      <BranchPicker
        virtualMcpId="vm-1"
        userLabel="tester"
        value="draft-1"
        baseBranch="main"
        orgId="org-1"
        orgSlug="org"
        userId="user-1"
        target={{ repositoryId: "repo-1" }}
        owner="acme"
        repo="site"
        sandboxMap={undefined}
        onChange={() => {}}
        placement="header"
      />
    </div>
  );
}
