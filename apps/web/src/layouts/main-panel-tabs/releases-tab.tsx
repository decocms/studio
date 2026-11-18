/**
 * Releases tab (the `releases` route) — a hosted v8 site's releases on the
 * hosted CMS, newest first: one row per revision, opening in place to its
 * note, who published it and a preview link. "Make current" on any
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
import { ChevronRight, Eye, File02 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
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

/** Release, who and when, status, action: the list's columns. */
const ROW_GRID =
  "grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5.5rem_7.5rem] items-center gap-4";

/** A note's lines after its title: what a Publish wrote about the change. */
function noteBody(message: string): string[] {
  return message
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
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
      className={cn(ROW_GRID, "px-4 py-3")}
    >
      <div
        className="flex min-w-0 items-center gap-2 pl-6"
        title={short(revision.id)}
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-muted-foreground/30"
        />
        <p className="truncate text-sm text-muted-foreground">
          {t("releases.unreadable")}
        </p>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {when ? formatWhen(when, language) : null}
      </p>
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
  const [openId, setOpenId] = useState<string | null>(null);

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="min-w-0 shrink-0">
        <h2 className="text-sm font-semibold">{t("releases.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("releases.subtitle")}
        </p>
        {revisions.length === 0 && !live ? (
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="releases-status"
          >
            {t("releases.nothingPublished")}
          </p>
        ) : null}
      </div>

      {revisions.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="overflow-hidden rounded-xl border border-border">
            <div
              className={cn(
                ROW_GRID,
                "border-b border-border px-4 py-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground",
              )}
            >
              <span className="pl-6">{t("releases.colRelease")}</span>
              <span>{t("releases.colWho")}</span>
              <span>{t("releases.colStatus")}</span>
              <span />
            </div>
            <ul className="divide-y divide-border">
              {revisions.map((revision) => {
                if (isUnreadable(revision))
                  return (
                    <UnreadableRow key={revision.id} revision={revision} />
                  );
                const latest = isLatest(revision);
                const expanded = openId === revision.id;
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
                const published = new Date(revision.meta.publishedAt);
                const who = [
                  authorOf(revision),
                  formatRelativeTime(published, language),
                ]
                  .filter(Boolean)
                  .join(" · ");
                const body = noteBody(revision.meta.message);
                return (
                  <li
                    key={revision.id}
                    id={`release-${revision.id}`}
                    data-testid="release-row"
                    className={cn(
                      "transition-colors",
                      highlight === revision.id && "bg-primary/10",
                    )}
                  >
                    <div
                      className={cn(
                        ROW_GRID,
                        "relative px-4 py-3 transition-colors hover:bg-muted/50",
                        expanded && "bg-muted/30",
                      )}
                    >
                      {/* The revision id is developer detail: a tooltip,
                          never on screen. */}
                      <div
                        className="flex min-w-0 items-center gap-2"
                        title={short(revision.id)}
                      >
                        <ChevronRight
                          size={14}
                          aria-hidden
                          className={cn(
                            "shrink-0 text-muted-foreground transition-transform",
                            expanded && "rotate-90",
                          )}
                        />
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            latest ? "bg-success" : "bg-muted-foreground/40",
                          )}
                        />
                        <div className="min-w-0">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() =>
                              setOpenId(expanded ? null : revision.id)
                            }
                            className="block max-w-full truncate text-left text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                          >
                            {titleOf(revision)}
                          </button>
                          {sameContentAs ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {sameContentAs}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {who}
                      </p>
                      <div>
                        {latest ? (
                          <Badge variant="success" data-badge="latest">
                            {t("releases.latest")}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex justify-end">
                        {canReapply(revision, live) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="relative"
                            disabled={reapply.isPending}
                            onClick={() => setConfirm(revision)}
                          >
                            {t("releases.reapply")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {expanded ? (
                      <div
                        className="grid gap-6 border-t border-border bg-muted/30 px-4 py-4 pl-12 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
                        data-testid="release-details"
                      >
                        <section className="flex min-w-0 flex-col gap-2">
                          <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                            {t("releases.note")}
                          </h3>
                          {body.length > 0 ? (
                            <ul className="flex flex-col gap-1.5">
                              {body.map((line, i) => (
                                <li
                                  // Note lines can repeat; their order is their identity.
                                  key={i}
                                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                                >
                                  <File02
                                    size={14}
                                    className="shrink-0 text-muted-foreground"
                                  />
                                  <span className="min-w-0 truncate">
                                    {line}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              {t("releases.noNote")}
                            </p>
                          )}
                          {sameContentAs && originalRow ? (
                            <button
                              type="button"
                              className="w-fit text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                              onClick={() => {
                                setOpenId(originalRow.id);
                                showRow(originalRow.id);
                              }}
                            >
                              {sameContentAs}
                            </button>
                          ) : null}
                        </section>
                        <section className="flex min-w-0 flex-col gap-2">
                          <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                            {t("releases.publishedBy")}
                          </h3>
                          <p className="text-sm">
                            {[
                              authorOf(revision),
                              formatWhen(published, language),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          {previewUrl ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="w-fit"
                              data-testid="release-preview"
                              onClick={() =>
                                window.open(previewUrl, "_blank", "noopener")
                              }
                            >
                              <Eye size={14} />
                              {t("releases.preview")}
                            </Button>
                          ) : null}
                        </section>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
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
      ) : null}

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
