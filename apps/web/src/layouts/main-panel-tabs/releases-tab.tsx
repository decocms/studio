/**
 * Releases tab (the `releases` route) — a hosted v8 site's timeline: main's
 * commits, newest first. A commit with a companion release can be
 * republished: that publishes a NEW release with its content (the API
 * commits it and runs Publish's release path), never moves the site back.
 * "Live" is what the site itself reports serving; the release just
 * published is "Going live…" until it does (releases-status.ts). A commit
 * without a companion (a developer push, or a Publish whose release write
 * failed) is listed with no badge and no action, as "Site update" (its own
 * message, which may name git, is developer detail in the tooltip).
 *
 * Business-user copy: no sha, CDN or git words on screen; one toast per
 * action (shared with Publish), with the error's own text behind Details.
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
  dismissPublishToast,
  errorDetail,
  toastPublishFailed,
} from "@/components/sections-editor/site-editor-toast.tsx";
import { notifySavedNotPublished } from "@/components/thread/repository/hosted-publish-feedback.ts";
import {
  HostedRequestError,
  type ReleaseCommit,
  usePutMainLive,
  useReleases,
  useRepublish,
} from "./releases-api";
import {
  type ReleaseBadge,
  canRepublish,
  formatWhen,
  releaseBadge,
  releaseTitle,
  titleLine,
} from "./releases-status";

const short = (sha: string) => sha.slice(0, 7);

/** What the confirmation dialog is asking about. */
type PendingConfirm = {
  commit: ReleaseCommit;
  /** The release's design differs from the site's: the second, explicit ask. */
  schemaMismatch: boolean;
};

function Badge({ badge }: { badge: ReleaseBadge }) {
  const t = useT();
  const label =
    badge.kind === "live"
      ? t("releases.live")
      : badge.kind === "goingLive"
        ? t("releases.goingLive")
        : t("releases.published");
  return (
    <span
      title={badge.hint ? t(`releases.${badge.hint}`) : undefined}
      data-badge={badge.kind}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs",
        badge.kind === "live"
          ? "bg-success/10 text-success"
          : "bg-muted text-muted-foreground",
      )}
    >
      {badge.kind === "goingLive" ? <Spinner className="size-3" /> : null}
      {label}
    </span>
  );
}

export function ReleasesTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const { org } = useProjectContext();
  const releases = useReleases(org.slug, virtualMcpId);
  const republish = useRepublish(org.slug, virtualMcpId);
  const putMainLive = usePutMainLive(org.slug, virtualMcpId);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

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
  // What latest.json names and what the site reports, as the first page
  // read them.
  const { current, serving } = releases.data.pages[0]!;
  const state = { current, serving };
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const titleOf = (commit: ReleaseCommit) => releaseTitle(t, commit, language);

  /** "Try again" when the content was saved but didn't go live. */
  const tryAgainLive = async () => {
    try {
      await putMainLive.mutateAsync();
      toast.success(t("releases.republished"), {
        ...FRESH_TOAST,
        id: SITE_EDITOR_PUBLISH_TOAST,
        description: undefined,
      });
    } catch (error) {
      notifySavedNotPublished(t, error, () => void tryAgainLive());
    }
  };

  const runRepublish = async (commit: ReleaseCommit, confirmed: boolean) => {
    const retry = () => void runRepublish(commit, confirmed);
    toast.loading(t("releases.republishing"), {
      ...FRESH_TOAST,
      id: SITE_EDITOR_PUBLISH_TOAST,
      description: undefined,
    });
    try {
      const result = await republish.mutateAsync({
        sha: commit.sha,
        confirm: confirmed,
      });
      if (result.result === "up-to-date") {
        toast.message(t("releases.alreadyShown"), {
          ...FRESH_TOAST,
          id: SITE_EDITOR_PUBLISH_TOAST,
          description: undefined,
        });
      } else if (result.release === "current") {
        toast.success(t("releases.republished"), {
          ...FRESH_TOAST,
          id: SITE_EDITOR_PUBLISH_TOAST,
          description: undefined,
        });
      } else {
        // Saved as a new release, not live yet: Publish's own "Try again".
        notifySavedNotPublished(t, null, () => void tryAgainLive());
      }
    } catch (error) {
      const code = error instanceof HostedRequestError ? error.code : null;
      if (code === "schema-mismatch") {
        // The confirm dialog asks the next step; the toast must not stay
        // behind it.
        dismissPublishToast();
        setConfirm({ commit, schemaMismatch: true });
        return;
      }
      if (code === "main-moved") {
        toastPublishFailed(t, {
          tone: "warning",
          headline: t("releases.publishedMeanwhile"),
          pending: t("releases.republishing"),
          retry,
        });
        return;
      }
      toastPublishFailed(t, {
        headline: t("releases.republishFailed"),
        detail: errorDetail(error),
        pending: t("releases.republishing"),
        retry,
      });
    }
  };

  const onConfirm = () => {
    const pending = confirm;
    setConfirm(null);
    if (pending) void runRepublish(pending.commit, pending.schemaMismatch);
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

  const header =
    serving?.source === "site"
      ? serving.revision
        ? t("releases.checkedWithSite", {
            when: formatRelativeTime(new Date(serving.lastSeen), language),
          })
        : t("releases.outsideStudio")
      : current
        ? t("releases.lastPublished", {
            when: formatRelativeTime(new Date(current.publishedAt), language),
          })
        : t("releases.nothingLive");

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
        {serving?.source !== "site" && current ? (
          <p className="text-xs text-muted-foreground">
            {t("releases.liveHint")}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border/60">
          {commits.map((commit) => {
            const badge = commit.hasRelease
              ? releaseBadge(commit.sha, state)
              : null;
            const original = commit.republishOf
              ? bySha.get(commit.republishOf.sha)
              : undefined;
            return (
              <li
                key={commit.sha}
                id={`release-${commit.sha}`}
                className={cn(
                  "flex items-center gap-3 px-1 py-2 transition-colors",
                  badge?.kind === "live" && "bg-muted/40",
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
                  {original ? (
                    <button
                      type="button"
                      className="truncate text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => showRow(original.sha)}
                    >
                      {t("releases.sameContentAs", {
                        when: formatWhen(new Date(original.date), language),
                      })}
                    </button>
                  ) : null}
                </div>
                {badge ? <Badge badge={badge} /> : null}
                {canRepublish(commit, state) ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("releases.actions")}
                      >
                        <DotsVertical size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={republish.isPending}
                        onSelect={() =>
                          setConfirm({ commit, schemaMismatch: false })
                        }
                      >
                        <RefreshCcw01 size={14} />
                        {t("releases.republish")}
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
            <AlertDialogTitle>{t("releases.republishTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm
                ? confirm.schemaMismatch
                  ? t("releases.schemaMismatchBody")
                  : t("releases.republishBody", {
                      title: titleOf(confirm.commit),
                    })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("releases.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>
              {confirm?.schemaMismatch
                ? t("releases.republishAnyway")
                : t("releases.republish")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
