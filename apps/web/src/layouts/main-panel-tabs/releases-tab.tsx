/**
 * Versions tab (the `releases` route) — a hosted v8 site's timeline: main's
 * commits, newest first. A commit with a companion release on the CDN can be
 * published ("Make current" on the API); the one latest.json names is
 * Published (read, never inferred). A commit without a companion (a
 * developer push, or a Publish whose release write failed) is listed with no
 * badge and no action, as "Site update" (its own message, which may name
 * git, is developer detail in the tooltip).
 *
 * Business-user copy: no sha, CDN or git words on screen; one toast per
 * action (shared with Publish), with the error's own text behind Details.
 */

import { useState } from "react";
import { ClockRewind, DotsVertical } from "@untitledui/icons";
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
  dismissPublishToast,
  errorDetail,
  toastPublishFailed,
  toastPublished,
} from "@/components/sections-editor/site-editor-toast.tsx";
import {
  HostedRequestError,
  type ReleaseCommit,
  useMakeCurrent,
  useReleases,
} from "./releases-api";

const short = (sha: string) => sha.slice(0, 7);
/** A commit message's title line: the version note a Publish wrote. */
const titleLine = (message: string) => message.split("\n")[0]?.trim() ?? "";

/** What the confirmation dialog is asking about. */
type PendingConfirm = {
  commit: ReleaseCommit;
  /** The target's schema differs from main's: the second, explicit ask. */
  schemaMismatch: boolean;
};

export function ReleasesTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const { org } = useProjectContext();
  const releases = useReleases(org.slug, virtualMcpId);
  const makeCurrent = useMakeCurrent(org.slug, virtualMcpId);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

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

  const runMakeCurrent = async (commit: ReleaseCommit, confirmed: boolean) => {
    try {
      await makeCurrent.mutateAsync({ sha: commit.sha, confirm: confirmed });
      toastPublished(t, t("releases.versionLive"));
    } catch (error) {
      if (
        error instanceof HostedRequestError &&
        error.code === "schema-mismatch"
      ) {
        // The confirm dialog asks the next step; a retry's "Publishing…"
        // toast must not stay behind it.
        dismissPublishToast();
        setConfirm({ commit, schemaMismatch: true });
        return;
      }
      // Failed: the badge stays where latest.json says (the list refetches).
      toastPublishFailed(t, {
        headline: t("releases.publishVersionFailed"),
        detail: errorDetail(error),
        retry: () => void runMakeCurrent(commit, confirmed),
      });
    }
  };

  const onConfirm = () => {
    const pending = confirm;
    setConfirm(null);
    if (pending) void runMakeCurrent(pending.commit, pending.schemaMismatch);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="min-w-0 shrink-0">
        <h2 className="text-sm font-semibold">{t("releases.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("releases.subtitle")}
        </p>
        <p className="mt-2 text-sm">
          <span className="text-muted-foreground">
            {current
              ? t("releases.publishedAgo", {
                  when: formatRelativeTime(
                    new Date(current.publishedAt),
                    language,
                  ),
                })
              : t("releases.nothingPublished")}
          </span>
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border/60">
          {commits.map((commit) => {
            const isCurrent = commit.sha === current?.revision;
            return (
              <li
                key={commit.sha}
                className={cn(
                  "flex items-center gap-3 px-1 py-2",
                  isCurrent && "bg-muted/40",
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
                  <p className="truncate text-sm">
                    {commit.hasRelease
                      ? titleLine(commit.message)
                      : t("releases.siteUpdate")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      commit.author,
                      formatRelativeTime(new Date(commit.date), language),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {isCurrent ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                    {t("releases.published")}
                  </span>
                ) : null}
                {commit.hasRelease && !isCurrent ? (
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
                        disabled={makeCurrent.isPending}
                        onSelect={() =>
                          setConfirm({ commit, schemaMismatch: false })
                        }
                      >
                        <ClockRewind size={14} />
                        {t("releases.publishVersion")}
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
            <AlertDialogTitle>
              {t("releases.publishVersionTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.schemaMismatch
                ? t("releases.schemaMismatchBody")
                : t("releases.publishVersionBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("releases.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>
              {confirm?.schemaMismatch
                ? t("releases.publishAnyway")
                : t("releases.publishVersion")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
