import { Loading01 } from "@untitledui/icons";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GitDiffResult } from "./sandbox-git-api.ts";
import { GitDiffList } from "./git-diff-list.tsx";
import { useT } from "@/web/i18n/use-t.ts";

interface Props {
  diffQuery: UseQueryResult<GitDiffResult>;
}

/**
 * Changes sub-tab: expandable Monaco diffs for committed PR changes,
 * using the same UI as the publish modal. Loads from sandbox git first,
 * then falls back to GitHub blobs when shallow clones hide merge-base.
 */
export function ChangesTab({ diffQuery }: Props) {
  const t = useT();

  if (diffQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
        <Loading01 className="h-4 w-4 animate-spin" />
        <span className="text-sm">{t("thread.changesTab.loadingChanges")}</span>
      </div>
    );
  }

  if (diffQuery.isError) {
    return (
      <div className="py-10 text-sm text-destructive">
        {t("thread.changesTab.couldntLoadPrChanges")}
      </div>
    );
  }

  return (
    <GitDiffList
      diff={diffQuery.data}
      rowClassName="px-0"
      emptyMessage={t("thread.changesTab.noCommittedChanges")}
    />
  );
}
