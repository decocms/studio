/**
 * Synced GitHub repos in the Library — one read-only folder card per
 * `org_repo_sync` config, rendered at the home root next to the system
 * folders, plus the "Add synced repo" flow: pick a repo (GitHubRepoPicker in
 * connection mode, which provisions the org-shared repo-scoped connection),
 * name the target volume, and ORG_REPO_SYNC_CREATE + first sync do the rest.
 *
 * The volume itself is a plain org volume, so opening the folder goes through
 * the normal VolumeView browse path; `useOrgRepoSyncVolumes` is what marks it
 * read-only there (the sync mirrors the repo — local edits would be deleted
 * on the next cycle).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Plus } from "@untitledui/icons";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  type GitHubImportPayload,
  GitHubRepoPicker,
} from "@/components/github-repo-picker";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { FolderCard, timeAgo } from "./cards";

export function useOrgRepoSyncs() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.orgRepoSyncs(org.id),
    staleTime: 60_000,
    queryFn: async () => (await studio.call("ORG_REPO_SYNC_LIST", {})).configs,
  });
}

/** Volume names owned by repo syncs — the Library browses them read-only. */
export function useOrgRepoSyncVolumes(): ReadonlySet<string> {
  const syncs = useOrgRepoSyncs();
  return new Set((syncs.data ?? []).map((c) => c.volume));
}

/** Suggest a volume name from the repo name (server re-validates). */
function volumeNameFor(repoName: string): string {
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 128);
}

export function SyncedRepoFolders({
  onOpenDir,
}: {
  onOpenDir: (path: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const syncs = useOrgRepoSyncs();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingImport, setPendingImport] =
    useState<GitHubImportPayload | null>(null);
  const [volumeName, setVolumeName] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.orgRepoSyncs(org.id) });

  const create = useMutation({
    mutationFn: async (input: { connectionId: string; volume: string }) => {
      const { config } = await studio.call("ORG_REPO_SYNC_CREATE", input);
      // First sync inline so the folder isn't empty until the next cron tick.
      return studio.call("ORG_REPO_SYNC_RUN", { id: config.id });
    },
    onSuccess: ({ result }) => {
      invalidate();
      setPendingImport(null);
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(
          t("library.syncedRepos.created", { volume: result.volume }),
        );
      }
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("library.syncedRepos.failed"),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => studio.call("ORG_REPO_SYNC_DELETE", { id }),
    onSuccess: () => {
      invalidate();
      toast.success(t("library.syncedRepos.removed"));
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("library.syncedRepos.failed"),
      );
    },
    onSettled: () => setPendingDeleteId(null),
  });

  const configs = syncs.data ?? [];
  const pendingDelete = configs.find((c) => c.id === pendingDeleteId);

  return (
    <>
      {configs.map((c) => (
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
          onDelete={() => setPendingDeleteId(c.id)}
        />
      ))}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="flex h-full min-h-16 items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <Plus size={16} />
        {t("library.syncedRepos.addRepo")}
      </button>

      <GitHubRepoPicker
        mode="connection"
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("library.syncedRepos.pickerTitle")}
        onImportComplete={(payload) => {
          setPickerOpen(false);
          setPendingImport(payload);
          setVolumeName(volumeNameFor(payload.repo.name));
        }}
      />

      <Dialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("library.syncedRepos.nameDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("library.syncedRepos.nameDialogDescription", {
                repo: pendingImport
                  ? `${pendingImport.repo.owner}/${pendingImport.repo.name}`
                  : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={volumeName}
            onChange={(e) => setVolumeName(e.target.value)}
            placeholder={t("library.syncedRepos.namePlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingImport(null)}
              disabled={create.isPending}
            >
              {t("library.syncedRepos.cancel")}
            </Button>
            <Button
              disabled={!volumeName.trim() || create.isPending}
              onClick={() => {
                if (!pendingImport) return;
                create.mutate({
                  connectionId: pendingImport.connectionId,
                  volume: volumeName.trim(),
                });
              }}
            >
              {create.isPending
                ? t("library.syncedRepos.creating")
                : t("library.syncedRepos.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.syncedRepos.removeTitle", {
                volume: pendingDelete?.volume ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("library.syncedRepos.removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("library.syncedRepos.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
              }}
            >
              {t("library.syncedRepos.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
