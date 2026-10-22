/**
 * Releases tab (the `releases` route) — a hosted v8 site's timeline: main's
 * commits, newest first. A commit with a companion release is a version that
 * can be reapplied: that publishes a NEW version with its content (the API
 * commits it and runs Publish's release path), never moves the site back.
 * "Latest" marks the version latest.json names (releases-status.ts). A commit
 * without a companion (a developer push, or a Publish whose release write
 * failed) is listed with no pill and no action, as "Site update" (its own
 * message, which may name git, is developer detail in the tooltip).
 *
 * Business-user copy: no sha, CDN or git words on screen, and calm words: a
 * version made for an earlier design is reapplied all the same, and the
 * dialog (and the toast) only add how to go back. One toast per action
 * (shared with Publish), with the error's own text behind Details.
 */

import { useState } from "react";
import { toast } from "sonner";
import { DotsVertical, RefreshCcw01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { formatRelativeTime } from "@/lib/format-time.ts";
import { useProjectContext } from "@/sdk";
import {
  ErrorDetails,
  FRESH_TOAST,
  SITE_EDITOR_PUBLISH_TOAST,
  errorDetail,
  toastPublishFailed,
} from "@/components/sections-editor/site-editor-toast.tsx";
import { notifySavedNotPublished } from "@/components/thread/repository/hosted-publish-feedback.ts";
import {
  HostedRequestError,
  type ReleaseCommit,
  useReapply,
  useReapplyCheck,
  useReleases,
  useRetryRelease,
} from "./releases-api";
import {
  canReapply,
  formatWhen,
  isLatest,
  latestSha,
  releaseTitle,
  titleLine,
} from "./releases-status";

const short = (sha: string) => sha.slice(0, 7);

function LatestPill() {
  const t = useT();
  return (
    <span
      data-badge="latest"
      className="flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
    >
      {t("releases.latest")}
    </span>
  );
}

export function ReleasesTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const { org } = useProjectContext();
  const releases = useReleases(org.slug, virtualMcpId);
  const reapply = useReapply(org.slug, virtualMcpId);
  const retryRelease = useRetryRelease(org.slug, virtualMcpId);
  const [confirm, setConfirm] = useState<ReleaseCommit | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  // Whether the version in the dialog was made for another design: only
  // adds how to go back; the dialog never waits for it.
  const check = useReapplyCheck(
    org.slug,
    virtualMcpId,
    confirm?.sha ?? null,
    latestSha(releases.data?.pages[0]),
  );

  if (releases.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (releases.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-10 text-center">
        <p className="text-sm font-medium">{t("releases.loadFailed")}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={releases.isRefetching}
          onClick={() => void releases.refetch()}
        >
          {t("siteEditor.tryAgain")}
        </Button>
        {releases.error.message ? (
          <div className="max-w-sm text-left">
            <ErrorDetails
              label={t("siteEditor.details")}
              detail={releases.error.message}
            />
          </div>
        ) : null}
      </div>
    );
  }

  const commits = releases.data.pages.flatMap((page) => page.commits);
  // What latest.json names, as the first page read it.
  const { current } = releases.data.pages[0]!;
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const titleOf = (commit: ReleaseCommit) => releaseTitle(t, commit, language);

  /** "Try again" when the content was saved but wasn't released. */
  const tryAgainRelease = async () => {
    try {
      await retryRelease.mutateAsync();
      toast.success(t("releases.reapplied"), {
        ...FRESH_TOAST,
        id: SITE_EDITOR_PUBLISH_TOAST,
        description: undefined,
      });
    } catch (error) {
      notifySavedNotPublished(t, error, () => void tryAgainRelease());
    }
  };

  const runReapply = async (commit: ReleaseCommit) => {
    const retry = () => void runReapply(commit);
    toast.loading(t("releases.reapplying"), {
      ...FRESH_TOAST,
      id: SITE_EDITOR_PUBLISH_TOAST,
      description: undefined,
    });
    try {
      const result = await reapply.mutateAsync({ sha: commit.sha });
      if (result.result === "up-to-date") {
        toast.message(t("releases.alreadyShown"), {
          ...FRESH_TOAST,
          id: SITE_EDITOR_PUBLISH_TOAST,
          description: undefined,
        });
      } else if (result.release === "current") {
        toast.success(t("releases.reapplied"), {
          ...FRESH_TOAST,
          id: SITE_EDITOR_PUBLISH_TOAST,
          description: result.schemaChanged
            ? t("releases.reappliedUndoHint")
            : undefined,
        });
      } else {
        // Saved as a new version, not released yet: Publish's own "Try again".
        notifySavedNotPublished(t, null, () => void tryAgainRelease());
      }
    } catch (error) {
      const code = error instanceof HostedRequestError ? error.code : null;
      if (code === "main-moved") {
        toastPublishFailed(t, {
          tone: "warning",
          headline: t("releases.publishedMeanwhile"),
          pending: t("releases.reapplying"),
          retry,
        });
        return;
      }
      toastPublishFailed(t, {
        headline: t("releases.reapplyFailed"),
        detail: errorDetail(error),
        pending: t("releases.reapplying"),
        retry,
      });
    }
  };

  const onConfirm = () => {
    const pending = confirm;
    setConfirm(null);
    if (pending) void runReapply(pending);
  };

  const showRow = (sha: string) => {
    document
      .getElementById(`release-${sha}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setHighlight(sha);
    setTimeout(
      () => setHighlight((shown) => (shown === sha ? null : shown)),
      2_000,
    );
  };

  const header = current
    ? t("releases.lastPublished", {
        when: formatRelativeTime(new Date(current.publishedAt), language),
      })
    : t("releases.nothingPublished");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="min-w-0 shrink-0">
        <h2 className="text-sm font-semibold">{t("releases.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("releases.subtitle")}
        </p>
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="releases-status"
        >
          {header}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border/60">
          {commits.map((commit) => {
            const latest = commit.hasRelease && isLatest(commit.sha, current);
            // The original's row, when it is loaded (else plain text).
            const originalRow = commit.reapplyOf
              ? bySha.get(commit.reapplyOf.sha)
              : undefined;
            const originalDate =
              originalRow?.date ?? commit.reapplyOf?.date ?? null;
            const sameContentAs = originalDate
              ? t("releases.sameContentAs", {
                  when: formatWhen(new Date(originalDate), language),
                })
              : null;
            return (
              <li
                key={commit.sha}
                id={`release-${commit.sha}`}
                className={cn(
                  "flex items-center gap-3 px-1 py-2 transition-colors",
                  latest && "bg-muted/40",
                  highlight === commit.sha && "bg-primary/10",
                )}
              >
                {/* The sha (and a developer push's own message) is developer
                    detail: a tooltip, never on screen. */}
                <div
                  className="min-w-0 flex-1"
                  title={
                    commit.hasRelease
                      ? short(commit.sha)
                      : `${short(commit.sha)} ${titleLine(commit.message)}`
                  }
                >
                  <p className="truncate text-sm">{titleOf(commit)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      commit.author,
                      formatRelativeTime(new Date(commit.date), language),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {sameContentAs && originalRow ? (
                    <button
                      type="button"
                      className="truncate text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => showRow(originalRow.sha)}
                    >
                      {sameContentAs}
                    </button>
                  ) : sameContentAs ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {sameContentAs}
                    </p>
                  ) : null}
                </div>
                {latest ? <LatestPill /> : null}
                {canReapply(commit, current) ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("releases.actions")}
                      >
                        <DotsVertical size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={reapply.isPending}
                        onSelect={() => setConfirm(commit)}
                      >
                        <RefreshCcw01 size={14} />
                        {t("releases.reapply")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
        {releases.hasNextPage ? (
          <div className="flex justify-center py-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={releases.isFetchingNextPage}
              onClick={() => void releases.fetchNextPage()}
            >
              {releases.isFetchingNextPage ? (
                <Spinner className="size-3.5" />
              ) : null}
              {t("releases.loadMore")}
            </Button>
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("releases.reapplyTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm
                ? t("releases.reapplyBody", { title: titleOf(confirm) })
                : null}
            </AlertDialogDescription>
            {confirm && check.data?.schemaChanged ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="reapply-undo-hint"
              >
                {t("releases.reapplyUndoHint")}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("releases.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>
              {t("releases.reapplyConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
