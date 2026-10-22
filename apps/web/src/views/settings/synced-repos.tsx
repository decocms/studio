import { useState } from "react";
import { Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { GitBranch01 } from "@untitledui/icons";
import { RepositoryPicker } from "@/components/repository-picker";
import { useRepositories, type Repository } from "@/hooks/use-git-providers";
import { GitProviderIcon } from "@/components/icons/git-provider-icon";

import { useT } from "@/i18n/use-t.ts";
import {
  type OrgRepoSyncConfig,
  useCreateOrgRepoSync,
  useDeleteOrgRepoSync,
  useOrgRepoSyncs,
} from "@/hooks/use-org-repo-syncs";
import { timeAgo } from "@/lib/format-time";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import {
  SettingsCard,
  SettingsCardItem,
} from "@/components/settings/settings-section";

/** Suggest a volume name from the repo name (server re-validates). */
function volumeNameFor(repoName: string): string {
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 128);
}

function syncStatus(
  c: OrgRepoSyncConfig,
  t: ReturnType<typeof useT>,
): { label: string; error: boolean } {
  if (c.lastSyncError) {
    return { label: c.lastSyncError, error: true };
  }
  if (c.lastSyncedAt) {
    return {
      label: t("library.syncedRepos.syncedAgo", {
        ago: timeAgo(c.lastSyncedAt),
      }),
      error: false,
    };
  }
  return { label: t("library.syncedRepos.waitingFirstSync"), error: false };
}

function SyncRow({
  config,
  onRemove,
}: {
  config: OrgRepoSyncConfig;
  onRemove: () => void;
}) {
  const t = useT();
  const status = syncStatus(config, t);
  const repositories = useRepositories();
  const repository = repositories.data?.find(
    (r) => r.id === config.repositoryId,
  );
  return (
    <SettingsCardItem
      icon={
        repository ? (
          <GitProviderIcon provider={repository.provider} size={16} />
        ) : (
          <GitBranch01 size={16} />
        )
      }
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">
            {repository?.path ?? `${config.repoOwner}/${config.repoName}`}
          </span>
          <span className="text-xs font-normal text-muted-foreground shrink-0">
            @{config.ref}
          </span>
        </span>
      }
      description={
        <span className={cn(status.error && "text-destructive")}>
          {t("settings.syncedRepos.rowSubtitle", { volume: config.volume })} ·{" "}
          {status.label}
        </span>
      }
      action={
        <Button variant="outline" size="sm" onClick={onRemove}>
          {t("settings.syncedRepos.remove")}
        </Button>
      }
    />
  );
}

function NoSyncedRepos({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <SettingsCard>
      <EmptyState
        size="inline"
        icon={<GitBranch01 />}
        title={t("settings.syncedRepos.emptyTitle")}
        description={t("settings.syncedRepos.emptyDescription")}
      >
        <Button onClick={onAdd} size="sm">
          <Plus size={14} />
          {t("settings.syncedRepos.addRepo")}
        </Button>
      </EmptyState>
    </SettingsCard>
  );
}

function SyncedReposContent() {
  const t = useT();
  const syncs = useOrgRepoSyncs();
  const create = useCreateOrgRepoSync();
  const remove = useDeleteOrgRepoSync();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<Repository | null>(null);
  const [volumeName, setVolumeName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<OrgRepoSyncConfig | null>(
    null,
  );

  function handleCreate() {
    if (!pendingImport || !volumeName.trim()) return;
    create.mutate(
      { repositoryId: pendingImport.id, volume: volumeName.trim() },
      {
        onSuccess: (config) => {
          // The first sync runs in the background (see useCreateOrgRepoSync);
          // the row's status flips from "waiting" once it lands or the cron
          // covers it. A sync failure shows up as the row's error state.
          setPendingImport(null);
          toast.success(
            t("settings.syncedRepos.created", { volume: config.volume }),
          );
        },
        onError: (err) => {
          toast.error(
            err instanceof Error
              ? err.message
              : t("settings.syncedRepos.failed"),
          );
        },
      },
    );
  }

  function handleRemove() {
    if (!pendingDelete) return;
    remove.mutate(pendingDelete.id, {
      onSuccess: () => toast.success(t("settings.syncedRepos.removed")),
      onError: (err) =>
        toast.error(
          err instanceof Error ? err.message : t("settings.syncedRepos.failed"),
        ),
      onSettled: () => setPendingDelete(null),
    });
  }

  if (syncs.isPending) return <Skeleton className="h-32 w-full" />;
  const configs = syncs.data ?? [];

  return (
    <>
      {configs.length === 0 ? (
        <NoSyncedRepos onAdd={() => setPickerOpen(true)} />
      ) : (
        <>
          <div className="flex items-center justify-end">
            <Button onClick={() => setPickerOpen(true)} size="sm">
              <Plus size={14} />
              {t("settings.syncedRepos.addRepo")}
            </Button>
          </div>
          <SettingsCard>
            {configs.map((c) => (
              <SyncRow
                key={c.id}
                config={c}
                onRemove={() => setPendingDelete(c)}
              />
            ))}
          </SettingsCard>
        </>
      )}

      <RepositoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("settings.syncedRepos.pickerTitle")}
        onPicked={({ repository }) => {
          setPickerOpen(false);
          setPendingImport(repository);
          setVolumeName(
            volumeNameFor(repository.path.split("/").at(-1) ?? repository.path),
          );
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
              {t("settings.syncedRepos.nameDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.syncedRepos.nameDialogDescription", {
                repo: pendingImport ? pendingImport.path : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={volumeName}
            onChange={(e) => setVolumeName(e.target.value)}
            placeholder={t("settings.syncedRepos.namePlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingImport(null)}
              disabled={create.isPending}
            >
              {t("settings.syncedRepos.cancel")}
            </Button>
            <Button
              disabled={!volumeName.trim() || create.isPending}
              onClick={handleCreate}
            >
              {create.isPending
                ? t("settings.syncedRepos.creating")
                : t("settings.syncedRepos.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.syncedRepos.removeTitle", {
                volume: pendingDelete?.volume ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.syncedRepos.removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.syncedRepos.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove}>
              {t("settings.syncedRepos.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function OrgSyncedReposPage() {
  return (
    <SettingsGroupPage group="storage">
      <SyncedReposContent />
    </SettingsGroupPage>
  );
}
