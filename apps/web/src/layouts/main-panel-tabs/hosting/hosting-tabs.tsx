/**
 * Hosting for Blocks v8 projects: Deploys, Domains and Variables as tabs, with
 * what is live in production up top. Redirects live in the site's blocks, so
 * this view leaves them out. Other projects keep the page in `index.tsx`.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Globe02,
  LinkExternal01,
  Rocket01,
  Server01,
  Variable,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SettingsPage } from "@/components/settings/settings-section";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import {
  fetchJson,
  fmtDuration,
  frameworkLabel,
  isUnauthorized,
  list,
  timeAgo,
  type Deployment,
  type DeploymentHistoryEvent,
  type DomainsResult,
  type EnvVar,
  type Secret,
  type Translate,
} from "./api";
import {
  BuildLogsSheet,
  DeployButton,
  LogsButton,
} from "./deployments-section";
import { DomainsSection } from "./domains-section";
import { EnvSection } from "./env-section";
import { SecretsSection } from "./secrets-section";
import { ListCard, ListMessage, ListRow, RowsSkeleton } from "./shell";

const STALE = 30_000;

/** History rows shown before the list asks to unfold the rest. */
const HISTORY_PAGE = 8;

type HostingView = "deploys" | "domains" | "variables";

function isHostingView(value: string): value is HostingView {
  return value === "deploys" || value === "domains" || value === "variables";
}

export function HostingTabs({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
  const site = siteSlug ?? "";
  const base = siteSlug
    ? `/api/${org.slug}/hosting/${encodeURIComponent(siteSlug)}`
    : "";
  const query = (key: readonly unknown[], path: string) => ({
    queryKey: key,
    queryFn: () => fetchJson(`${base}${path}`),
    enabled,
    retry: false,
    staleTime: STALE,
  });

  const [view, setView] = useState<HostingView>("deploys");
  const deploymentsQuery = useQuery(
    query(KEYS.hostingDeployments(org.slug, site), "/deployments"),
  );
  const historyQuery = useQuery(
    query(
      KEYS.hostingDeploymentHistory(org.slug, site),
      "/deployments/history?limit=50",
    ),
  );
  const envQuery = useQuery(query(KEYS.hostingEnv(org.slug, site), "/env"));
  const secretsQuery = useQuery(
    query(KEYS.hostingSecrets(org.slug, site), "/secrets"),
  );
  const domainsQuery = useQuery(
    query(KEYS.hostingDomains(org.slug, site), "/domains"),
  );

  if (!siteSlug) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<Server01 className="size-5" />}
          title={t("mainPanelTabs.hostingTab.noSiteTitle")}
          description={t("mainPanelTabs.hostingTab.noSiteDescription")}
        />
      </div>
    );
  }

  if (
    isUnauthorized(deploymentsQuery.error) &&
    isUnauthorized(envQuery.error)
  ) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<Server01 className="size-5" />}
          title={t("mainPanelTabs.hostingTab.notConnectedTitle")}
          description={t("mainPanelTabs.hostingTab.notConnectedDescription")}
        />
      </div>
    );
  }

  const deployments = list<Deployment>(deploymentsQuery.data, "items");
  const live = deployments.find((d) => d.up === true);
  const liveUrl = live?.servingUrl ?? null;
  const liveHost = liveUrl
    ? liveUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : null;
  const domainsData = domainsQuery.data as DomainsResult | undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pb-2 pt-4">
        <ToggleGroup
          type="single"
          variant="segmented"
          size="sm"
          value={view}
          aria-label={t("mainPanelTabs.hostingTab.viewsLabel")}
          onValueChange={(next) => {
            if (isHostingView(next)) setView(next);
          }}
        >
          <ToggleGroupItem value="deploys">
            <Rocket01 />
            {t("mainPanelTabs.hostingTab.tabDeploys")}
          </ToggleGroupItem>
          <ToggleGroupItem value="domains">
            <Globe02 />
            {t("mainPanelTabs.hostingTab.domains")}
          </ToggleGroupItem>
          <ToggleGroupItem value="variables">
            <Variable />
            {t("mainPanelTabs.hostingTab.tabVariables")}
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-3">
          {liveUrl && liveHost && (
            <a
              href={liveUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {liveHost}
              <LinkExternal01 className="size-3" />
            </a>
          )}
          {!live && (
            <DeployButton base={base} orgSlug={org.slug} site={siteSlug} />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-8">
        <div className="w-full">
          {view === "deploys" && (
            <DeploysView
              base={base}
              orgSlug={org.slug}
              site={siteSlug}
              live={live}
              deploymentsLoading={deploymentsQuery.isLoading}
              deploymentsError={deploymentsQuery.error}
              history={list<DeploymentHistoryEvent>(historyQuery.data, "items")}
              historyLoading={historyQuery.isLoading}
              historyError={historyQuery.error}
            />
          )}
          {view === "domains" && (
            <SettingsPage>
              <DomainsSection
                base={base}
                orgSlug={org.slug}
                site={siteSlug}
                domains={domainsData?.items ?? []}
                dnsTemplate={domainsData?.dnsTemplate ?? []}
                isLoading={domainsQuery.isLoading}
                error={domainsQuery.error}
              />
            </SettingsPage>
          )}
          {view === "variables" && (
            <SettingsPage>
              <EnvSection
                base={base}
                orgSlug={org.slug}
                site={siteSlug}
                envVars={list<EnvVar>(envQuery.data, "vars")}
                codeVars={list<EnvVar>(envQuery.data, "codeVars")}
                isLoading={envQuery.isLoading}
                error={envQuery.error}
              />
              <SecretsSection
                base={base}
                orgSlug={org.slug}
                site={siteSlug}
                secrets={list<Secret>(secretsQuery.data, "secrets")}
                isLoading={secretsQuery.isLoading}
                error={secretsQuery.error}
              />
            </SettingsPage>
          )}
        </div>
      </div>
    </div>
  );
}

function DeploysView({
  base,
  orgSlug,
  site,
  live,
  deploymentsLoading,
  deploymentsError,
  history,
  historyLoading,
  historyError,
}: {
  base: string;
  orgSlug: string;
  site: string;
  live: Deployment | undefined;
  deploymentsLoading: boolean;
  deploymentsError: unknown;
  history: DeploymentHistoryEvent[];
  historyLoading: boolean;
  historyError: unknown;
}) {
  const t = useT();
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [logsTarget, setLogsTarget] = useState<{
    commit: string;
    env: string;
  } | null>(null);
  const visible = history.slice(0, historyLimit);
  const hidden = history.length - visible.length;
  const servingCommit = live?.commitSha ?? null;

  function openLogs(commit: string | null | undefined, env?: string | null) {
    if (!commit) return;
    setLogsTarget({ commit, env: env ?? "production" });
  }

  return (
    <div className="flex flex-col gap-4">
      {deploymentsLoading ? (
        <RowsSkeleton rows={1} />
      ) : deploymentsError ? (
        <ListCard>
          <ListMessage>
            {t("mainPanelTabs.hostingTab.deploymentsError")}
          </ListMessage>
        </ListCard>
      ) : live ? (
        <LiveCard base={base} orgSlug={orgSlug} site={site} live={live} />
      ) : (
        <ListCard>
          <EmptyState
            icon={<Rocket01 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.noLiveDeploy")}
            className="py-8"
          />
        </ListCard>
      )}

      {historyLoading ? (
        <RowsSkeleton />
      ) : historyError ? (
        <ListCard>
          <ListMessage>
            {t("mainPanelTabs.hostingTab.deployHistoryError")}
          </ListMessage>
        </ListCard>
      ) : history.length === 0 ? (
        <ListCard>
          <ListMessage>
            {t("mainPanelTabs.hostingTab.noDeployHistory")}
          </ListMessage>
        </ListCard>
      ) : (
        <ListCard>
          {visible.map((event) => (
            <HistoryRow
              key={event.id}
              event={event}
              isLive={
                Boolean(servingCommit) && event.commitSha === servingCommit
              }
              onLogs={() => openLogs(event.commitSha, event.env)}
            />
          ))}
          {hidden > 0 && (
            <div className="flex justify-center p-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHistoryLimit(history.length)}
              >
                {t("mainPanelTabs.hostingTab.showMoreHistory", {
                  count: String(hidden),
                })}
              </Button>
            </div>
          )}
        </ListCard>
      )}

      <BuildLogsSheet
        base={base}
        orgSlug={orgSlug}
        site={site}
        target={logsTarget}
        onOpenChange={(open) => {
          if (!open) setLogsTarget(null);
        }}
      />
    </div>
  );
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

function LiveCard({
  base,
  orgSlug,
  site,
  live,
}: {
  base: string;
  orgSlug: string;
  site: string;
  live: Deployment;
}) {
  const t = useT();
  const facts = [
    frameworkLabel(live.framework),
    timeAgo(live.finishedAt ?? live.startedAt ?? live.createdAt),
    live.durationMs != null
      ? t("mainPanelTabs.hostingTab.buildTook", {
          duration: fmtDuration(live.durationMs),
        })
      : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-edge">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
        <Rocket01 className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-medium text-success">
          <span className="size-1.5 rounded-full bg-success" />
          {t("mainPanelTabs.hostingTab.liveInProduction")}
        </p>
        <p className="truncate text-sm font-semibold">
          {t("mainPanelTabs.hostingTab.commitTitle", {
            sha: live.shortCommit ?? shortSha(live.commitSha),
          })}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {facts.join(" · ")}
        </p>
      </div>
      <DeployButton
        base={base}
        orgSlug={orgSlug}
        site={site}
        variant="outline"
        label={t("mainPanelTabs.hostingTab.actionRedeploy")}
      />
    </div>
  );
}

/** What a deploy-timeline event was: its kind, or for legacy rows its action. */
function eventLabel(event: DeploymentHistoryEvent, t: Translate): string {
  const type = (event.type ?? "").toLowerCase();
  if (type === "build") return t("mainPanelTabs.hostingTab.typeBuild");
  if (type === "fast-deploy")
    return t("mainPanelTabs.hostingTab.typeFastDeploy");
  if (type === "deploy") return t("mainPanelTabs.hostingTab.typeDeploy");
  const action = (event.action ?? "").toLowerCase();
  if (action.includes("rollback"))
    return t("mainPanelTabs.hostingTab.actionRollback");
  if (action.includes("redeploy"))
    return t("mainPanelTabs.hostingTab.actionRedeploy");
  return t("mainPanelTabs.hostingTab.actionDeploy");
}

type EventStatus = "live" | "ready" | "failed" | "pending" | "unknown";

function eventStatus(
  event: DeploymentHistoryEvent,
  isLive: boolean,
): EventStatus {
  const outcome = (event.outcome ?? "").toLowerCase();
  if (outcome === "failure") return "failed";
  if (outcome === "pending") return "pending";
  if (isLive) return "live";
  if (outcome === "success") return "ready";
  return "unknown";
}

function HistoryRow({
  event,
  isLive,
  onLogs,
}: {
  event: DeploymentHistoryEvent;
  isLive: boolean;
  onLogs: () => void;
}) {
  const t = useT();
  const status = eventStatus(event, isLive);
  const env = (event.env ?? "production").toLowerCase();
  const statusText = {
    live: t("mainPanelTabs.hostingTab.live"),
    ready: t("mainPanelTabs.hostingTab.statusReady"),
    failed: t("mainPanelTabs.hostingTab.statusFailed"),
    pending: t("mainPanelTabs.hostingTab.statusInProgress"),
    unknown: "—",
  }[status];
  return (
    <ListRow className="py-3">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "live" && "bg-success",
          status === "ready" && "bg-muted-foreground/40",
          status === "failed" && "bg-destructive",
          status === "pending" && "animate-pulse bg-warning",
          status === "unknown" && "bg-muted-foreground/20",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {eventLabel(event, t)}{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {shortSha(event.commitSha)}
          </span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {[event.actor, timeAgo(event.createdAt)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <Badge variant={env === "production" ? "secondary" : "outline"}>
        {env === "production"
          ? t("mainPanelTabs.hostingTab.production")
          : env === "preview"
            ? t("mainPanelTabs.hostingTab.preview")
            : event.env}
      </Badge>
      <span
        className={cn(
          "w-24 shrink-0 text-xs",
          status === "live" && "font-medium text-success",
          status === "failed" && "font-medium text-destructive",
          (status === "ready" ||
            status === "pending" ||
            status === "unknown") &&
            "text-muted-foreground",
        )}
      >
        {statusText}
      </span>
      <LogsButton commit={event.commitSha} onClick={onLogs} />
    </ListRow>
  );
}
