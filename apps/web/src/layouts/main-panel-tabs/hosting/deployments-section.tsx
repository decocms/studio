/**
 * What the site is serving and how it got there: the current deployments per
 * environment, the deploy timeline, and the build logs behind any of them.
 */

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Clock,
  FileCode02,
  FlipBackward,
  GitCommit,
  LinkExternal01,
  RefreshCw02,
  Rocket01,
  Server01,
  Zap,
} from "@untitledui/icons";
import { toast } from "sonner";
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
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import {
  errorText,
  fetchJson,
  fmtDuration,
  frameworkLabel,
  isUnauthorized,
  list,
  mutateJson,
  statusVariant,
  timeAgo,
  type BuildLogs,
  type Deployment,
  type DeploymentHistoryEvent,
  type Translate,
} from "./api";
import {
  ExpandChevron,
  HostingSection,
  ListCard,
  ListMessage,
  RowsSkeleton,
  TableDetailsRow,
  Th,
} from "./shell";

/** History rows shown before the list asks to unfold the rest. */
const HISTORY_PAGE = 8;

export function DeployButton({
  base,
  orgSlug,
  site,
}: {
  base: string;
  orgSlug: string;
  site: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const deployMutation = useMutation({
    mutationFn: () => mutateJson(`${base}/deploy`, "POST", { mode: "current" }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.hostingDeployments(orgSlug, site),
      });
      // The deploy also produces a new history event; refresh that too.
      queryClient.invalidateQueries({
        queryKey: KEYS.hostingDeploymentHistory(orgSlug, site),
      });
      toast.success(t("mainPanelTabs.hostingTab.toastDeployQueued"));
      setConfirm(false);
    },
    onError: (error) => toast.error(errorText(error)),
  });

  return (
    <>
      <Button
        size="sm"
        onClick={() => setConfirm(true)}
        disabled={deployMutation.isPending}
      >
        <Rocket01 />
        {deployMutation.isPending
          ? t("mainPanelTabs.hostingTab.deploying")
          : t("mainPanelTabs.hostingTab.deploy")}
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mainPanelTabs.hostingTab.deployConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("mainPanelTabs.hostingTab.deployConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deployMutation.isPending}>
              {t("mainPanelTabs.hostingTab.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deployMutation.mutate();
              }}
              disabled={deployMutation.isPending}
            >
              {t("mainPanelTabs.hostingTab.deploy")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function actionBadge(action: string | null | undefined, t: Translate) {
  const a = (action ?? "").toLowerCase();
  if (a.includes("rollback")) {
    return (
      <Badge variant="warning">
        <FlipBackward />
        {t("mainPanelTabs.hostingTab.actionRollback")}
      </Badge>
    );
  }
  if (a.includes("redeploy")) {
    return (
      <Badge variant="secondary">
        <RefreshCw02 />
        {t("mainPanelTabs.hostingTab.actionRedeploy")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Rocket01 />
      {t("mainPanelTabs.hostingTab.actionDeploy")}
    </Badge>
  );
}

/** The deploy-event KIND (build / fast-deploy / deploy). Legacy rows carry no
 *  `type`, so fall back to the action badge to keep them meaningful. */
function typeBadge(
  type: string | null | undefined,
  action: string | null | undefined,
  t: Translate,
) {
  const ty = (type ?? "").toLowerCase();
  if (ty === "build") {
    return (
      <Badge variant="secondary">
        <FileCode02 />
        {t("mainPanelTabs.hostingTab.typeBuild")}
      </Badge>
    );
  }
  if (ty === "fast-deploy") {
    return (
      <Badge variant="secondary">
        <Zap />
        {t("mainPanelTabs.hostingTab.typeFastDeploy")}
      </Badge>
    );
  }
  if (ty === "deploy") {
    return (
      <Badge variant="secondary">
        <Rocket01 />
        {t("mainPanelTabs.hostingTab.typeDeploy")}
      </Badge>
    );
  }
  return actionBadge(action, t);
}

/** The deploy-event OUTCOME. Omitted on legacy rows that carry no `outcome`.
 *  `pending` is a calm neutral "in progress", not a warning. */
function outcomeBadge(outcome: string | null | undefined, t: Translate) {
  const o = (outcome ?? "").toLowerCase();
  if (o === "success") {
    return (
      <Badge variant="success">
        {t("mainPanelTabs.hostingTab.outcomeSuccess")}
      </Badge>
    );
  }
  if (o === "failure") {
    return (
      <Badge variant="destructive">
        {t("mainPanelTabs.hostingTab.outcomeFailure")}
      </Badge>
    );
  }
  if (o === "pending") {
    return (
      <Badge variant="secondary">
        <Clock />
        {t("mainPanelTabs.hostingTab.outcomePending")}
      </Badge>
    );
  }
  return null;
}

function LogsButton({
  commit,
  onClick,
}: {
  commit: string | null | undefined;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <IconButton
      label={t("mainPanelTabs.hostingTab.buildLogs")}
      onClick={onClick}
      disabled={!commit}
    >
      <FileCode02 />
    </IconButton>
  );
}

/** Build-logs dialog. Re-fetches on every open (staleTime/gcTime 0) because the
 *  presigned `url` expires ~5min; the URL is never cached. */
function BuildLogsDialog({
  base,
  orgSlug,
  site,
  target,
  onOpenChange,
}: {
  base: string;
  orgSlug: string;
  site: string;
  /** The commit/env whose logs to show, or null when the dialog is closed. */
  target: { commit: string; env: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const open = target != null;
  const commit = target?.commit ?? "";
  const env = target?.env ?? "";

  const logsQuery = useQuery({
    queryKey: KEYS.hostingBuildLogs(orgSlug, site, commit, env),
    queryFn: () =>
      fetchJson(
        `${base}/deployments/logs?commit=${encodeURIComponent(
          commit,
        )}&env=${encodeURIComponent(env)}`,
      ),
    enabled: open && Boolean(commit),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  const data = logsQuery.data as BuildLogs | undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("mainPanelTabs.hostingTab.buildLogsTitle")}
          </DialogTitle>
        </DialogHeader>
        <p className="font-mono text-xs text-muted-foreground">
          {t("mainPanelTabs.hostingTab.buildLogsCommit", {
            commit: commit.slice(0, 7),
          })}
        </p>

        {isUnauthorized(logsQuery.error) ? (
          <EmptyState
            icon={<Server01 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.notConnectedTitle")}
            description={t("mainPanelTabs.hostingTab.notConnectedDescription")}
          />
        ) : logsQuery.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : logsQuery.error ? (
          <ListMessage>
            {t("mainPanelTabs.hostingTab.buildLogsError")}
          </ListMessage>
        ) : data && data.configured === false ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-8 text-center">
            <AlertCircle className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {t("mainPanelTabs.hostingTab.buildLogsNotWiredTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.reason ??
                t("mainPanelTabs.hostingTab.buildLogsNotWiredDescription")}
            </p>
          </div>
        ) : data?.text ? (
          <div className="flex flex-col gap-2">
            <pre className="max-h-[52vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
              {data.text}
            </pre>
            {data.truncated && (
              <p className="text-xs text-warning">
                {t("mainPanelTabs.hostingTab.buildLogsTruncated")}
              </p>
            )}
            {data.url && (
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <LinkExternal01 className="size-3.5" />
                {t("mainPanelTabs.hostingTab.buildLogsOpenFull")}
              </a>
            )}
          </div>
        ) : data?.url ? (
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <LinkExternal01 className="size-4" />
            {t("mainPanelTabs.hostingTab.buildLogsOpenFull")}
          </a>
        ) : (
          <ListMessage>
            {t("mainPanelTabs.hostingTab.buildLogsEmpty")}
          </ListMessage>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeploymentsSection({
  base,
  orgSlug,
  site,
  enabled,
  deployments,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  enabled: boolean;
  deployments: Deployment[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [logsTarget, setLogsTarget] = useState<{
    commit: string;
    env: string;
  } | null>(null);

  const historyQuery = useQuery({
    queryKey: KEYS.hostingDeploymentHistory(orgSlug, site),
    queryFn: () => fetchJson(`${base}/deployments/history?limit=50`),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const history = list<DeploymentHistoryEvent>(historyQuery.data, "items");
  const visibleHistory = history.slice(0, historyLimit);
  const hiddenHistory = history.length - visibleHistory.length;

  // LIVE marker: the serving deployment is the one currently `up`; its commit is
  // what the site actually serves. Any history event on that commit is live.
  const servingCommit =
    deployments.find((d) => d.up === true)?.commitSha ??
    deployments.find((d) => d.production === true && d.up)?.commitSha ??
    null;

  const openLogs = (commit: string | null | undefined, env?: string | null) => {
    if (!commit) return;
    setLogsTarget({ commit, env: env ?? "production" });
  };

  return (
    <>
      <HostingSection
        title={t("mainPanelTabs.hostingTab.deployments")}
        description={t("mainPanelTabs.hostingTab.deploymentsDescription", {
          site,
        })}
        count={deployments.length}
      >
        {isLoading ? (
          <RowsSkeleton />
        ) : error ? (
          <ListCard>
            <ListMessage>
              {t("mainPanelTabs.hostingTab.deploymentsError")}
            </ListMessage>
          </ListCard>
        ) : deployments.length === 0 ? (
          <ListCard>
            <EmptyState
              icon={<Rocket01 className="size-5" />}
              title={t("mainPanelTabs.hostingTab.noDeployments")}
              className="py-10"
            />
          </ListCard>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <Th>{t("mainPanelTabs.hostingTab.colCommit")}</Th>
                <Th>{t("mainPanelTabs.hostingTab.colStatus")}</Th>
                <Th>{t("mainPanelTabs.hostingTab.colFramework")}</Th>
                <Th className="text-right">
                  {t("mainPanelTabs.hostingTab.colDuration")}
                </Th>
                <Th className="text-right">
                  {t("mainPanelTabs.hostingTab.colUpdated")}
                </Th>
                <Th className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((d) => {
                const hasMessage = Boolean(d.buildMessage);
                const isExpanded = expanded === d.id;
                return (
                  <Fragment key={d.id}>
                    <TableRow
                      className={cn(
                        hasMessage && "cursor-pointer hover:bg-muted/40",
                      )}
                      onClick={
                        hasMessage
                          ? () => setExpanded(isExpanded ? null : d.id)
                          : undefined
                      }
                    >
                      <TableCell className="px-4">
                        <div className="flex items-center gap-1.5">
                          {hasMessage ? (
                            <ExpandChevron
                              open={isExpanded}
                              onClick={() =>
                                setExpanded(isExpanded ? null : d.id)
                              }
                            />
                          ) : (
                            <GitCommit className="size-4 text-muted-foreground/60" />
                          )}
                          <span className="font-mono text-xs">
                            {d.shortCommit ?? d.commitSha?.slice(0, 7) ?? "—"}
                          </span>
                          {d.production === true && (
                            <Badge variant="outline">
                              {t("mainPanelTabs.hostingTab.production")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={statusVariant(d.phase)}>
                            {d.phase ?? "—"}
                          </Badge>
                          {d.up === true && (
                            <Badge variant="success">
                              {t("mainPanelTabs.hostingTab.live")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {frameworkLabel(d.framework) ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                        {fmtDuration(d.durationMs)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {timeAgo(d.finishedAt ?? d.startedAt ?? d.createdAt)}
                      </TableCell>
                      <TableCell
                        className="pr-3 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <LogsButton
                          commit={d.commitSha}
                          onClick={() => openLogs(d.commitSha, d.env)}
                        />
                      </TableCell>
                    </TableRow>
                    {hasMessage && (
                      <TableDetailsRow open={isExpanded} colSpan={6}>
                        <p className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                          {d.buildMessage}
                        </p>
                      </TableDetailsRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </HostingSection>

      <HostingSection
        title={t("mainPanelTabs.hostingTab.deployHistory")}
        description={t("mainPanelTabs.hostingTab.deployHistoryDescription")}
        count={history.length}
      >
        {historyQuery.isLoading ? (
          <RowsSkeleton />
        ) : historyQuery.error ? (
          <ListCard>
            <ListMessage>
              {t("mainPanelTabs.hostingTab.deployHistoryError")}
            </ListMessage>
          </ListCard>
        ) : history.length === 0 ? (
          <ListCard>
            <EmptyState
              icon={<Rocket01 className="size-5" />}
              title={t("mainPanelTabs.hostingTab.noDeployHistory")}
              className="py-10"
            />
          </ListCard>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <Th className="pl-4">
                  {t("mainPanelTabs.hostingTab.colAction")}
                </Th>
                <Th>{t("mainPanelTabs.hostingTab.colCommit")}</Th>
                <Th>{t("mainPanelTabs.hostingTab.colFramework")}</Th>
                <Th>{t("mainPanelTabs.hostingTab.colActor")}</Th>
                <Th className="text-right">
                  {t("mainPanelTabs.hostingTab.colDate")}
                </Th>
                <Th className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleHistory.map((h) => {
                const isLive =
                  Boolean(servingCommit) && h.commitSha === servingCommit;
                return (
                  <TableRow key={h.id}>
                    <TableCell className="pl-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {typeBadge(h.type, h.action, t)}
                        {outcomeBadge(h.outcome, t)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">
                          {h.commitSha?.slice(0, 7) ?? "—"}
                        </span>
                        {isLive && (
                          <Badge variant="success">
                            {t("mainPanelTabs.hostingTab.live")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {frameworkLabel(h.framework) ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {h.actor ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {timeAgo(h.createdAt)}
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <LogsButton
                        commit={h.commitSha}
                        onClick={() => openLogs(h.commitSha, h.env)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
              {hiddenHistory > 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="p-2 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setHistoryLimit(history.length)}
                    >
                      {t("mainPanelTabs.hostingTab.showMoreHistory", {
                        count: String(hiddenHistory),
                      })}
                    </Button>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </HostingSection>

      <BuildLogsDialog
        base={base}
        orgSlug={orgSlug}
        site={site}
        target={logsTarget}
        onOpenChange={(open) => {
          if (!open) setLogsTarget(null);
        }}
      />
    </>
  );
}
