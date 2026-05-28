import { Loading01 } from "@untitledui/icons";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GitDiffResult } from "./sandbox-git-api.ts";
import { GitDiffList } from "./git-diff-list.tsx";

interface Props {
  diffQuery: UseQueryResult<GitDiffResult>;
}

/**
 * Changes sub-tab: expandable Monaco diffs for committed PR changes,
 * using the same UI as the publish modal. Loads from sandbox git first,
 * then falls back to GitHub blobs when shallow clones hide merge-base.
 */
export function ChangesTab({ diffQuery }: Props) {
  if (diffQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
        <Loading01 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading changes…</span>
      </div>
    );
  }

  if (diffQuery.isError) {
    return (
      <div className="py-10 text-sm text-destructive">
        Couldn't load PR changes.
      </div>
    );
  }

  return (
    <GitDiffList
      diff={diffQuery.data}
      rowClassName="px-0"
      emptyMessage="No committed changes in this pull request"
    />
  );
}
