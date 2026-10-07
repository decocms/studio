/**
 * Releases tab — a hosted v8 site's releases on the delivery CDN: what
 * latest.json serves now, and main's git history. A commit that has a
 * release can be made current (a temporary rollback: only latest.json
 * changes, and the next Publish or Resync overrides it); a commit the CMS
 * never published is listed without an action.
 */

import { useState } from "react";
import { ClockRewind, DotsVertical, RefreshCw01 } from "@untitledui/icons";
import { toast } from "sonner";
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
import { formatTimeAgo } from "@/lib/format-time.ts";
import { useProjectContext } from "@/sdk";
import {
  HostedRequestError,
  type ReleaseCommit,
  type ReleaseState,
  useMakeCurrent,
  useReleases,
  useResync,
} from "./releases-api";

const short = (sha: string) => sha.slice(0, 7);

/** What a confirmation dialog is asking about. */
type PendingConfirm =
  | { kind: "make-current"; commit: ReleaseCommit }
  | { kind: "schema-mismatch"; commit: ReleaseCommit }
  | { kind: "resync-over-rollback" };

export function ReleasesTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const releases = useReleases(org.slug, virtualMcpId);
  const makeCurrent = useMakeCurrent(org.slug, virtualMcpId);
  const resync = useResync(org.slug, virtualMcpId);
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
        <p className="max-w-sm text-xs text-muted-foreground">
          {releases.error.message}
        </p>
      </div>
    );
  }

  const first = releases.data.pages[0]!;
  const commits = releases.data.pages.flatMap((page) => page.commits);
  const { current: serving } = first;

  const runMakeCurrent = async (commit: ReleaseCommit, confirmed: boolean) => {
    try {
      await makeCurrent.mutateAsync({ sha: commit.sha, confirm: confirmed });
      toast.success(t("releases.madeCurrent", { sha: short(commit.sha) }));
    } catch (error) {
      if (
        error instanceof HostedRequestError &&
        error.code === "schema-mismatch"
      ) {
        setConfirm({ kind: "schema-mismatch", commit });
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const runResync = async (confirmed: boolean) => {
    try {
      const result = (await resync.mutateAsync({ confirm: confirmed })) as {
        result?: string;
      };
      if (result.result === "pending")
        toast.warning(t("releases.resyncPending"));
      else toast.success(t("releases.resynced"));
    } catch (error) {
      if (error instanceof HostedRequestError && error.code === "rolled-back") {
        setConfirm({ kind: "resync-over-rollback" });
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const onConfirm = () => {
    const pending = confirm;
    setConfirm(null);
    if (!pending) return;
    if (pending.kind === "resync-over-rollback") void runResync(true);
    else
      void runMakeCurrent(pending.commit, pending.kind === "schema-mismatch");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("releases.title")}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t("releases.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={resync.isPending}
          onClick={() => void runResync(false)}
        >
          {resync.isPending ? (
            <Spinner className="size-3.5" />
          ) : (
            <RefreshCw01 size={14} />
          )}
          {t("releases.resync")}
        </Button>
      </div>

      <div className="shrink-0 rounded-xl border border-border/60 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("releases.serving")}
          </span>
          <StateBadge state={first.state} />
        </div>
        {serving ? (
          <p className="mt-1 text-sm">
            <span className="font-mono">{short(serving.revision)}</span>
            <span className="text-muted-foreground">
              {" · "}
              {t("releases.publishedAgo", {
                when: formatTimeAgo(new Date(serving.publishedAt)),
              })}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("releases.nothingPublished")}
          </p>
        )}
        {first.state === "rolled-back" ? (
          <p className="mt-1 text-xs text-warning">
            {t("releases.rolledBackHint", { head: short(first.head) })}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border/60">
          {commits.map((commit) => {
            const isCurrent = commit.sha === serving?.revision;
            return (
              <li
                key={commit.sha}
                className={cn(
                  "flex items-center gap-3 px-1 py-2",
                  isCurrent && "bg-muted/40",
                )}
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {short(commit.sha)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{commit.message}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[commit.author, formatTimeAgo(new Date(commit.date))]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {isCurrent ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                    {t("releases.current")}
                  </span>
                ) : commit.published ? (
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
                          setConfirm({ kind: "make-current", commit })
                        }
                      >
                        <ClockRewind size={14} />
                        {t("releases.makeCurrent")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("releases.notPublished")}
                  </span>
                )}
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
              {confirm?.kind === "resync-over-rollback"
                ? t("releases.resyncConfirmTitle")
                : t("releases.makeCurrentTitle", {
                    sha: confirm ? short(confirm.commit.sha) : "",
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "resync-over-rollback"
                ? t("releases.resyncConfirmBody")
                : confirm?.kind === "schema-mismatch"
                  ? t("releases.schemaMismatchBody")
                  : t("releases.makeCurrentBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("releases.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>
              {confirm?.kind === "resync-over-rollback"
                ? t("releases.resync")
                : t("releases.makeCurrent")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StateBadge({ state }: { state: ReleaseState }) {
  const t = useT();
  const label =
    state === "live"
      ? t("releases.state.live")
      : state === "rolled-back"
        ? t("releases.state.rolledBack")
        : t("releases.state.pending");
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs",
        state === "live" && "bg-success/10 text-success",
        state === "rolled-back" && "bg-warning/10 text-warning",
        state === "pending" && "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}
