/**
 * Releases tab — a hosted v8 site's timeline: main's commits, newest first.
 * A commit with a companion release on the CDN can be made current; the one
 * latest.json names is Current (read, never inferred). A commit without a
 * companion (a developer push, or a Publish whose release write failed) is
 * just a merge: listed, with no badge and no action.
 */

import { useState } from "react";
import { ClockRewind, DotsVertical } from "@untitledui/icons";
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
  useMakeCurrent,
  useReleases,
} from "./releases-api";

const short = (sha: string) => sha.slice(0, 7);

/** What the confirmation dialog is asking about. */
type PendingConfirm = {
  commit: ReleaseCommit;
  /** The target's schema differs from main's: the second, explicit ask. */
  schemaMismatch: boolean;
};

export function ReleasesTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
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
        <p className="max-w-sm text-xs text-muted-foreground">
          {releases.error.message}
        </p>
      </div>
    );
  }

  const commits = releases.data.pages.flatMap((page) => page.commits);
  // What latest.json names, as the first page read it.
  const { current } = releases.data.pages[0]!;

  const runMakeCurrent = async (commit: ReleaseCommit, confirmed: boolean) => {
    try {
      await makeCurrent.mutateAsync({ sha: commit.sha, confirm: confirmed });
      toast.success(t("releases.madeCurrent", { sha: short(commit.sha) }));
    } catch (error) {
      if (
        error instanceof HostedRequestError &&
        error.code === "schema-mismatch"
      ) {
        setConfirm({ commit, schemaMismatch: true });
        return;
      }
      // Failed: the badge stays where latest.json says (the list refetches).
      toast.error(error instanceof Error ? error.message : String(error));
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
          {current ? (
            <>
              <span className="text-muted-foreground">
                {t("releases.currentOnCdn")}{" "}
              </span>
              <span className="font-mono">{short(current.revision)}</span>
              <span className="text-muted-foreground">
                {" · "}
                {t("releases.madeCurrentAgo", {
                  when: formatTimeAgo(new Date(current.publishedAt)),
                })}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {t("releases.nothingOnCdn")}
            </span>
          )}
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
                ) : commit.hasRelease ? (
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
                        {t("releases.makeCurrent")}
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
              {t("releases.makeCurrentTitle", {
                sha: confirm ? short(confirm.commit.sha) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.schemaMismatch
                ? t("releases.schemaMismatchBody")
                : t("releases.makeCurrentBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("releases.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>
              {t("releases.makeCurrent")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
