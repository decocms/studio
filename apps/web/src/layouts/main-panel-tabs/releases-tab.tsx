/**
 * Releases tab (the `releases` route) — a hosted v8 site's releases on the
 * hosted CMS, newest first: one row per revision. "Make current" on any
 * other than the latest publishes a NEW release with its content (a
 * rollback, or a roll-forward), never moves the site back. "Latest" marks
 * the release latest.json names (releases-status.ts). A release whose
 * details couldn't be read is a plain row with its date only: no actions.
 *
 * Business-user copy: no id, CDN or git words on screen. The author is a
 * Studio user id, shown by the org member's name. One toast per action
 * (shared with Publish), with the error's own text behind Details.
 */

import { useState } from "react";
import { toast } from "sonner";
import { DotsVertical, Eye, RefreshCcw01 } from "@untitledui/icons";
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
import { CmsRequestError } from "@/cms/cms-api";
import type { OrgMemberRow } from "@/components/sections-editor/conflict-author";
import { useMembersQuery } from "@/hooks/use-members";
import {
  type ReadableRelease,
  type ReleaseRevision,
  useReapply,
  useReleases,
} from "./releases-api";
import { releasePreviewUrl } from "@/components/sections-editor/preview-link";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import {
  canPreviewRelease,
  canReapply,
  formatWhen,
  isLatest,
  isUnreadable,
  releaseTitle,
  revisionTime,
} from "./releases-status";

const short = (id: string) => id.slice(0, 12);

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

/**
 * A release whose details (its meta.json) couldn't be read: no note, author
 * or actions, only the date its id carries.
 */
function UnreadableRow({ revision }: { revision: ReleaseRevision }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const when = revisionTime(revision.id);
  return (
    <li
      id={`release-${revision.id}`}
      data-testid="release-unreadable"
      className="flex items-center gap-3 px-1 py-2"
    >
      <div className="min-w-0 flex-1" title={short(revision.id)}>
        <p className="truncate text-sm text-muted-foreground">
          {t("releases.unreadable")}
        </p>
        {when ? (
          <p className="truncate text-xs text-muted-foreground">
            {formatWhen(when, language)}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function ReleasesTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const { org } = useProjectContext();
  const releases = useReleases(org.slug, virtualMcpId);
  const reapply = useReapply(org.slug, virtualMcpId);
  // An author is a Studio user id: its name comes from the org's members.
  const membersQuery = useMembersQuery();
  const members =
    (membersQuery.data as { data?: { members?: OrgMemberRow[] } } | undefined)
      ?.data?.members ?? [];
  // "Preview this version": the site's own page reading that release, from
  // the same address Studio's preview uses (its preview hosts honour it).
  const { previewServerUrl } = useSessionRuntime(virtualMcpId);
  const [confirm, setConfirm] = useState<ReadableRelease | null>(null);
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

  const revisions = releases.data.pages.flatMap((page) => page.revisions);
  const byId = new Map(
    revisions.flatMap((r) => (isUnreadable(r) ? [] : [[r.id, r] as const])),
  );
  const current = revisions.find(isLatest) ?? null;
  const live = releases.data.pages[0]?.live ?? null;
  const titleOf = (revision: ReadableRelease) =>
    releaseTitle(t, revision.meta, language);
  const authorOf = (revision: ReadableRelease) =>
    members
      .find((m) => m.userId === revision.meta.author)
      ?.user?.name?.trim() || null;

  const runReapply = async (revision: ReadableRelease) => {
    const retry = () => void runReapply(revision);
    toast.loading(t("releases.reapplying"), {
      ...FRESH_TOAST,
      id: SITE_EDITOR_PUBLISH_TOAST,
      description: undefined,
    });
    try {
      const result = await reapply.mutateAsync({ id: revision.id });
      if (result.result === "up-to-date") {
        toast.message(t("releases.alreadyShown"), {
          ...FRESH_TOAST,
          id: SITE_EDITOR_PUBLISH_TOAST,
          description: undefined,
        });
      } else {
        toast.success(t("releases.reapplied"), {
          ...FRESH_TOAST,
          id: SITE_EDITOR_PUBLISH_TOAST,
          description: undefined,
        });
      }
    } catch (error) {
      const code = error instanceof CmsRequestError ? error.code : null;
      if (code === "not_published") {
        // Never published: nothing to make current over (contract §4.11).
        toastPublishFailed(t, {
          tone: "warning",
          headline: t("releases.notPublished"),
        });
        return;
      }
      if (code === "production_moved") {
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

  const showRow = (id: string) => {
    document
      .getElementById(`release-${id}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setHighlight(id);
    setTimeout(
      () => setHighlight((shown) => (shown === id ? null : shown)),
      2_000,
    );
  };

  const header = current
    ? t("releases.lastPublished", {
        when: formatRelativeTime(new Date(current.meta.publishedAt), language),
      })
    : live
      ? null
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
          {revisions.map((revision) => {
            if (isUnreadable(revision))
              return <UnreadableRow key={revision.id} revision={revision} />;
            const latest = isLatest(revision);
            // The original's row, when it is loaded (else plain text).
            const original = revision.meta.reapplyOf;
            const originalRow = original ? byId.get(original) : undefined;
            const originalDate = originalRow
              ? new Date(originalRow.meta.publishedAt)
              : original
                ? revisionTime(original)
                : null;
            const sameContentAs = originalDate
              ? t("releases.sameContentAs", {
                  when: formatWhen(originalDate, language),
                })
              : null;
            const previewUrl = canPreviewRelease(revision)
              ? releasePreviewUrl(previewServerUrl, revision.id)
              : null;
            return (
              <li
                key={revision.id}
                id={`release-${revision.id}`}
                className={cn(
                  "flex items-center gap-3 px-1 py-2 transition-colors",
                  latest && "bg-muted/40",
                  highlight === revision.id && "bg-primary/10",
                )}
              >
                {/* The revision id is developer detail: a tooltip, never on
                    screen. */}
                <div className="min-w-0 flex-1" title={short(revision.id)}>
                  <p className="truncate text-sm">{titleOf(revision)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      authorOf(revision),
                      formatRelativeTime(
                        new Date(revision.meta.publishedAt),
                        language,
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {sameContentAs && originalRow ? (
                    <button
                      type="button"
                      className="truncate text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => showRow(originalRow.id)}
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
                {canReapply(revision, live) || previewUrl ? (
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
                      {previewUrl ? (
                        <DropdownMenuItem
                          data-testid="release-preview"
                          onSelect={() =>
                            window.open(previewUrl, "_blank", "noopener")
                          }
                        >
                          <Eye size={14} />
                          {t("releases.preview")}
                        </DropdownMenuItem>
                      ) : null}
                      {canReapply(revision, live) ? (
                        <DropdownMenuItem
                          disabled={reapply.isPending}
                          onSelect={() => setConfirm(revision)}
                        >
                          <RefreshCcw01 size={14} />
                          {t("releases.reapply")}
                        </DropdownMenuItem>
                      ) : null}
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
