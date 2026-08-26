/**
 * HostingTab — read-only per-site hosting view (control-plane BFF proxy).
 *
 * Surfaces deployments, environment variables, and redirects for the site
 * this agent resolves against. All data is fetched through the server-side
 * proxy at `/api/:org/hosting/:site/*`, so the control-plane service token
 * never reaches the browser — the client only ever sees the proxied JSON.
 *
 * Prototype: read-only. Write/deploy actions are a follow-up.
 */

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Server01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface Deployment {
  id?: string;
  status?: string;
  url?: string;
  createdAt?: string;
  created_at?: string;
}

interface EnvVar {
  key?: string;
  name?: string;
  value?: string;
}

interface Redirect {
  from?: string;
  to?: string;
  status?: number;
  statusCode?: number;
}

/**
 * The control-plane REST shapes aren't pinned yet (prototype), so accept both
 * a bare array and a `{ <key>: [...] }` envelope and normalize to an array.
 */
function asList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

async function fetchHosting(
  url: string,
  fallbackMessage: string,
): Promise<unknown> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `${fallbackMessage} (${res.status})`;
    throw new Error(message);
  }
  return body;
}

function statusVariant(
  status: string | undefined,
): "success" | "destructive" | "warning" | "secondary" {
  const s = (status ?? "").toLowerCase();
  if (s.includes("ready") || s.includes("success") || s.includes("active")) {
    return "success";
  }
  if (s.includes("fail") || s.includes("error")) return "destructive";
  if (s.includes("build") || s.includes("pending") || s.includes("progress")) {
    return "warning";
  }
  return "secondary";
}

function SectionState({
  loading,
  error,
  empty,
  loadingLabel,
  emptyLabel,
  children,
}: {
  loading: boolean;
  error: Error | null;
  empty: boolean;
  loadingLabel: string;
  emptyLabel: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-6">{loadingLabel}</div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive py-6">
        <AlertCircle size={16} />
        {error.message}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="text-sm text-muted-foreground py-6">{emptyLabel}</div>
    );
  }
  return <>{children}</>;
}

export function HostingTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);

  const enabled = Boolean(siteSlug);
  const base = siteSlug
    ? `/api/${org.slug}/hosting/${encodeURIComponent(siteSlug)}`
    : "";

  const deploymentsQuery = useQuery({
    queryKey: KEYS.hostingDeployments(org.slug, siteSlug ?? ""),
    queryFn: () =>
      fetchHosting(
        `${base}/deployments`,
        t("mainPanelTabs.hostingTab.deploymentsError"),
      ),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  const envQuery = useQuery({
    queryKey: KEYS.hostingEnv(org.slug, siteSlug ?? ""),
    queryFn: () =>
      fetchHosting(`${base}/env`, t("mainPanelTabs.hostingTab.envError")),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  const redirectsQuery = useQuery({
    queryKey: KEYS.hostingRedirects(org.slug, siteSlug ?? ""),
    queryFn: () =>
      fetchHosting(
        `${base}/redirects`,
        t("mainPanelTabs.hostingTab.redirectsError"),
      ),
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  if (!siteSlug) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <EmptyState
          icon={<Server01 size={20} />}
          title={t("mainPanelTabs.hostingTab.noSiteTitle")}
          description={t("mainPanelTabs.hostingTab.noSiteDescription")}
        />
      </div>
    );
  }

  const deployments = asList<Deployment>(deploymentsQuery.data, "deployments");
  const envVars = asList<EnvVar>(envQuery.data, "env");
  const redirects = asList<Redirect>(redirectsQuery.data, "redirects");

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6 flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Server01 size={18} className="text-muted-foreground" />
          {t("mainPanelTabs.hostingTab.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("mainPanelTabs.hostingTab.subtitle", { site: siteSlug })}
        </p>
      </div>

      {/* Deployments */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("mainPanelTabs.hostingTab.deployments")}
        </h3>
        <SectionState
          loading={deploymentsQuery.isLoading}
          error={deploymentsQuery.error as Error | null}
          empty={deployments.length === 0}
          loadingLabel={t("mainPanelTabs.hostingTab.loading")}
          emptyLabel={t("mainPanelTabs.hostingTab.noDeployments")}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mainPanelTabs.hostingTab.colId")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colStatus")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colUrl")}</TableHead>
                <TableHead>
                  {t("mainPanelTabs.hostingTab.colCreated")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((d, i) => (
                <TableRow key={d.id ?? i}>
                  <TableCell className="font-mono text-xs">
                    {d.id ?? "—"}
                  </TableCell>
                  <TableCell>
                    {d.status ? (
                      <Badge variant={statusVariant(d.status)}>
                        {d.status}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {d.url ? (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {d.url}
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.createdAt ?? d.created_at ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionState>
      </section>

      {/* Environment variables */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("mainPanelTabs.hostingTab.env")}
        </h3>
        <SectionState
          loading={envQuery.isLoading}
          error={envQuery.error as Error | null}
          empty={envVars.length === 0}
          loadingLabel={t("mainPanelTabs.hostingTab.loading")}
          emptyLabel={t("mainPanelTabs.hostingTab.noEnv")}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mainPanelTabs.hostingTab.colKey")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colValue")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {envVars.map((e, i) => (
                <TableRow key={e.key ?? e.name ?? i}>
                  <TableCell className="font-mono text-xs">
                    {e.key ?? e.name ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground max-w-md truncate">
                    {e.value ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionState>
      </section>

      {/* Redirects */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("mainPanelTabs.hostingTab.redirects")}
        </h3>
        <SectionState
          loading={redirectsQuery.isLoading}
          error={redirectsQuery.error as Error | null}
          empty={redirects.length === 0}
          loadingLabel={t("mainPanelTabs.hostingTab.loading")}
          emptyLabel={t("mainPanelTabs.hostingTab.noRedirects")}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mainPanelTabs.hostingTab.colFrom")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colTo")}</TableHead>
                <TableHead>{t("mainPanelTabs.hostingTab.colStatus")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redirects.map((r, i) => (
                <TableRow key={`${r.from ?? ""}-${i}`}>
                  <TableCell className="font-mono text-xs">
                    {r.from ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.to ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.status ?? r.statusCode ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionState>
      </section>
    </div>
  );
}
