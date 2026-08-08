/**
 * Synced GitHub repos in the Library — one read-only folder card per
 * `org_repo_sync` config, rendered at the home root next to the system
 * folders. Navigation only: adding/removing syncs lives in Settings →
 * Synced repos (views/settings/synced-repos.tsx).
 *
 * The volume itself is a plain org volume, so opening the folder goes through
 * the normal VolumeView browse path; `useOrgRepoSyncVolumes` is what marks it
 * read-only there (the sync mirrors the repo — local edits would be deleted
 * on the next cycle).
 */

import { useT } from "@/i18n/use-t.ts";
import { GitHubIcon } from "@/components/icons/github-icon";
import { useOrgRepoSyncs } from "@/hooks/use-org-repo-syncs";
import { FolderCard, timeAgo } from "./cards";

export function SyncedRepoFolders({
  onOpenDir,
}: {
  onOpenDir: (path: string) => void;
}) {
  const t = useT();
  const syncs = useOrgRepoSyncs();

  return (
    <>
      {(syncs.data ?? []).map((c) => (
        <FolderCard
          key={c.id}
          name={c.volume}
          glyph={GitHubIcon}
          tone="system"
          readOnly
          meta={`${c.repoOwner}/${c.repoName}`}
          subtitle={
            c.lastSyncError
              ? t("library.syncedRepos.syncFailed")
              : c.lastSyncedAt
                ? t("library.syncedRepos.syncedAgo", {
                    ago: timeAgo(c.lastSyncedAt),
                  })
                : t("library.syncedRepos.waitingFirstSync")
          }
          onOpen={() => onOpenDir(c.volume)}
        />
      ))}
    </>
  );
}
