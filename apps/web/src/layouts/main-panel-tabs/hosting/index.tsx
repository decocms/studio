/**
 * HostingTab: the per-site hosting view, on the settings kit.
 *
 * Deployments, environment, secrets, domains and redirects for the site this
 * project resolves against. Every request goes through the control-plane BFF
 * proxy at `/api/:org/hosting/:site/*`, so the service token stays server-side.
 */

import { useQuery } from "@tanstack/react-query";
import { LinkExternal01, Server01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Page } from "@/components/page";
import { SettingsPage } from "@/components/settings/settings-section";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import {
  fetchJson,
  frameworkLabel,
  isUnauthorized,
  list,
  type Deployment,
  type DomainsResult,
  type EnvVar,
  type Redirect,
  type Secret,
} from "./api";
import { DeployButton, DeploymentsSection } from "./deployments-section";
import { DomainsSection } from "./domains-section";
import { EnvSection } from "./env-section";
import { RedirectsSection } from "./redirects-section";
import { SecretsSection } from "./secrets-section";

const STALE = 30_000;

export function HostingTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
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

  const site = siteSlug ?? "";
  const deploymentsQuery = useQuery(
    query(KEYS.hostingDeployments(org.slug, site), "/deployments"),
  );
  const envQuery = useQuery(query(KEYS.hostingEnv(org.slug, site), "/env"));
  const secretsQuery = useQuery(
    query(KEYS.hostingSecrets(org.slug, site), "/secrets"),
  );
  const redirectsQuery = useQuery(
    query(KEYS.hostingRedirects(org.slug, site), "/redirects"),
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

  // Pre-token / not-connected: when the proxy answers 401 across the board, show
  // one calm configuration state instead of red errors.
  const allUnauthorized =
    isUnauthorized(deploymentsQuery.error) &&
    isUnauthorized(envQuery.error) &&
    isUnauthorized(redirectsQuery.error);
  if (allUnauthorized) {
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
  const envVars = list<EnvVar>(envQuery.data, "vars");
  const codeVars = list<EnvVar>(envQuery.data, "codeVars");
  const secrets = list<Secret>(secretsQuery.data, "secrets");
  const redirects = list<Redirect>(redirectsQuery.data, "items");
  const domainsData = domainsQuery.data as DomainsResult | undefined;
  const domains = domainsData?.items ?? [];
  const dnsTemplate = domainsData?.dnsTemplate ?? [];
  const live = deployments.find((d) => d.up === true);
  const framework = frameworkLabel(
    (live ?? deployments.find((d) => d.framework))?.framework,
  );
  const liveUrl = live?.servingUrl ?? null;
  const liveHost = liveUrl
    ? liveUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : null;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Page.Body maxWidth="max-w-5xl">
        <SettingsPage>
          <div className="flex flex-col gap-2">
            <Page.Title
              actions={
                <DeployButton base={base} orgSlug={org.slug} site={siteSlug} />
              }
            >
              <span className="inline-flex items-center gap-2.5">
                {t("mainPanelTabs.hostingTab.title")}
                {framework && <Badge variant="secondary">{framework}</Badge>}
              </span>
            </Page.Title>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              {t("mainPanelTabs.hostingTab.subtitle", { site: siteSlug })}
              {liveUrl && liveHost && (
                <>
                  <span aria-hidden>·</span>
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-foreground hover:underline"
                  >
                    {liveHost}
                    <LinkExternal01 className="size-3" />
                  </a>
                </>
              )}
            </p>
          </div>

          <DeploymentsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            enabled={enabled}
            deployments={deployments}
            isLoading={deploymentsQuery.isLoading}
            error={deploymentsQuery.error}
          />
          <EnvSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            envVars={envVars}
            codeVars={codeVars}
            isLoading={envQuery.isLoading}
            error={envQuery.error}
          />
          <SecretsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            secrets={secrets}
            isLoading={secretsQuery.isLoading}
            error={secretsQuery.error}
          />
          <DomainsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            domains={domains}
            dnsTemplate={dnsTemplate}
            isLoading={domainsQuery.isLoading}
            error={domainsQuery.error}
          />
          <RedirectsSection
            base={base}
            orgSlug={org.slug}
            site={siteSlug}
            redirects={redirects}
            isLoading={redirectsQuery.isLoading}
            error={redirectsQuery.error}
          />
        </SettingsPage>
      </Page.Body>
    </div>
  );
}
