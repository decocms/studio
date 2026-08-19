/**
 * Settings → Synced repos — manage the org's GitHub repo → volume syncs
 * (`org_repo_sync`). Add picks a repo via GitHubRepoPicker (connection mode,
 * which provisions the org-shared repo-scoped connection) and names the
 * target volume; each config row shows the last sync status and offers
 * remove. The synced content itself is browsed in the Library, where the
 * volume presents as a read-only folder.
 */

import { useState } from "react";
import { Plus } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { Page } from "@/components/page";
import { SettingsPage } from "@/components/settings/settings-section";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  type GitHubImportPayload,
  GitHubRepoPicker,
} from "@/components/github-repo-picker";
import { useT } from "@/i18n/use-t.ts";
import {
  type OrgRepoSyncConfig,
  useCreateOrgRepoSync,
  useDeleteOrgRepoSync,
  useOrgRepoSyncs,
} from "@/hooks/use-org-repo-syncs";
import { timeAgo } from "@/layouts/library/cards";
import { SettingsSubnav } from "@/components/settings/settings-subnav";

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
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <GitHubIcon size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">
              {config.repoOwner}/{config.repoName}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">
              @{config.ref}
            </span>
          </div>
          <p
            className={cn(
              "text-xs mt-0.5 truncate",
              status.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {t("settings.syncedRepos.rowSubtitle", { volume: config.volume })} ·{" "}
            {status.label}
          </p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onRemove}>
        {t("settings.syncedRepos.remove")}
      </Button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <GitHubIcon size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">
          {t("settings.syncedRepos.emptyTitle")}
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {t("settings.syncedRepos.emptyDescription")}
        </p>
      </div>
      <Button onClick={onAdd} size="sm" className="mt-2">
        <Plus size={14} />
        {t("settings.syncedRepos.addRepo")}
      </Button>
    </div>
  );
}

function SyncedReposContent() {
  const t = useT();
  const syncs = useOrgRepoSyncs();
  const create = useCreateOrgRepoSync();
  const remove = useDeleteOrgRepoSync();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingImport, setPendingImport] =
    useState<GitHubImportPayload | null>(null);
  const [volumeName, setVolumeName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<OrgRepoSyncConfig | null>(
    null,
  );

  function handleCreate() {
    if (!pendingImport || !volumeName.trim()) return;
    create.mutate(
      {
        connectionId: pendingImport.connectionId,
        volume: volumeName.trim(),
      },
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
      <p className="text-sm text-muted-foreground">
        {t("settings.syncedRepos.pageDescription")}
      </p>

      {configs.length === 0 ? (
        <EmptyState onAdd={() => setPickerOpen(true)} />
      ) : (
        <>
          <div className="flex items-center justify-end">
            <Button onClick={() => setPickerOpen(true)} size="sm">
              <Plus size={14} />
              {t("settings.syncedRepos.addRepo")}
            </Button>
          </div>
          <section className="rounded-2xl border border-border/60 bg-background px-5 py-2">
            {configs.map((c) => (
              <SyncRow
                key={c.id}
                config={c}
                onRemove={() => setPendingDelete(c)}
              />
            ))}
          </section>
        </>
      )}

      <GitHubRepoPicker
        mode="connection"
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t("settings.syncedRepos.pickerTitle")}
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
              {t("settings.syncedRepos.nameDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.syncedRepos.nameDialogDescription", {
                repo: pendingImport
                  ? `${pendingImport.repo.owner}/${pendingImport.repo.name}`
                  : "",
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
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <SettingsSubnav group="storage" />
            <SyncedReposContent />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
