/**
 * ReportsTab — what the sidebar's Reports destination opens for an org that has
 * no report yet (`?main=reports`).
 *
 * Reports used to be hidden until a diagnostic existed, which left no way to ask
 * for one from inside the product: the only entry was the public
 * /commerce-onboarding funnel. So the destination is always listed now and lands
 * here, on an empty state that starts the diagnostic.
 *
 * Starting it is exactly the onboarding hand-off, reused rather than
 * reimplemented: COMMERCE_DISCOVERY_SETUP claims the site, then we navigate to
 * the org home thread with `?connect=1`, which mounts the blocking
 * CommerceConnectModal — the step that asks for the data sources (GA4/GSC/VTEX/
 * GitHub), triggers COMMERCE_DISCOVERY_RUN and opens the report.
 *
 * Once a diagnostic does exist this tab is a redirect to the report app, so a
 * click made while the diagnostic read was still in flight (or a stale
 * `?main=reports` URL) still lands on the report.
 */
import { useMutation } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { ArrowRight, BarChartSquare02 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  normalizeReportsSiteUrl,
  siteUrlToHost,
} from "@decocms/shared/reports/site-url";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { EmptyState } from "@/components/empty-state";
import { ErrorBoundary } from "@/components/error-boundary";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useCommerceDiagnostic } from "@/hooks/use-commerce-diagnostic";
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@/sdk";
import { parseSelfToolResult } from "@/routes/commerce-onboarding/self-tool-result.ts";
import { translateSiteError } from "@/routes/commerce-onboarding/site-error.ts";
import { MainPanelLoading } from "./main-panel-loading";
import { formatPinnedViewTabId } from "./tab-id";

export function ReportsTab() {
  const { diagnostic, isLoading, siteUrl, connectionId } =
    useCommerceDiagnostic();

  if (isLoading) return <MainPanelLoading />;

  if (diagnostic) {
    return (
      <Navigate
        to="."
        search={(prev: Record<string, unknown>) => ({
          ...prev,
          main: formatPinnedViewTabId(
            connectionId,
            COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
          ),
        })}
        replace
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <ErrorBoundary
        fallback={() => <StartDiagnosticState claimedSiteUrl={siteUrl} />}
      >
        <Suspense fallback={<MainPanelLoading />}>
          <StartDiagnostic claimedSiteUrl={siteUrl} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

/** The empty state's chrome. Without `children` (the error fallback, where no
 *  self client is available) the form is replaced by the claimed store's host,
 *  so the panel still explains itself instead of rendering an error. */
function StartDiagnosticState({
  claimedSiteUrl,
  children,
}: {
  claimedSiteUrl: string | null;
  children?: ReactNode;
}) {
  const t = useT();
  const host = siteUrlToHost(claimedSiteUrl ?? undefined);
  return (
    <EmptyState
      className="h-full w-full"
      image={<BarChartSquare02 size={48} className="text-muted-foreground" />}
      title={t("reports.emptyState.title")}
      description={t("reports.emptyState.description")}
      descriptionClassName="max-w-[420px]"
      actionsClassName="w-full max-w-md flex-col items-stretch"
      actions={
        children ??
        (host ? (
          <p className="text-center text-sm text-muted-foreground">{host}</p>
        ) : null)
      }
    />
  );
}

function StartDiagnostic({
  claimedSiteUrl,
}: {
  claimedSiteUrl: string | null;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const [siteInput, setSiteInput] = useState(
    siteUrlToHost(claimedSiteUrl ?? undefined) ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: async (url: string) =>
      parseSelfToolResult<unknown>(
        await selfClient.callTool({
          name: "COMMERCE_DISCOVERY_SETUP",
          arguments: { siteUrl: url },
        }),
      ),
    retry: false,
  });

  const start = async (rawSiteUrl: string) => {
    const normalized = normalizeReportsSiteUrl(rawSiteUrl);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    setError(null);
    const domain = siteUrlToHost(normalized.value) ?? undefined;
    track("reports_start_diagnostic_submitted", {
      organization_id: org.id,
      domain,
    });
    try {
      await setupMutation.mutateAsync(normalized.value);
    } catch (err) {
      track("reports_start_diagnostic_failed", {
        organization_id: org.id,
        domain,
        error: err instanceof Error ? err.message : String(err),
      });
      // Server errors pass through; the sentinel is translated at render.
      setError(err instanceof Error ? err.message : "__configurationFailed");
      return;
    }
    // The connections step triggers the run and opens the report.
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId: crypto.randomUUID() },
      search: {
        virtualmcpid: getWellKnownDecopilotVirtualMCP(org.id).id,
        connect: "1",
        siteUrl: normalized.value,
      },
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void start(siteInput);
  };

  return (
    <StartDiagnosticState claimedSiteUrl={claimedSiteUrl}>
      <form className="flex w-full flex-col gap-2" onSubmit={onSubmit}>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t("reports.emptyState.siteUrlLabel")}
            type="text"
            inputMode="url"
            className="min-w-0 flex-1"
            value={siteInput}
            onChange={(event) => setSiteInput(event.target.value)}
            placeholder={t("reports.emptyState.siteUrlPlaceholder")}
            aria-invalid={!!error}
            disabled={setupMutation.isPending}
          />
          <Button type="submit" disabled={setupMutation.isPending}>
            {setupMutation.isPending
              ? t("reports.emptyState.starting")
              : t("reports.emptyState.start")}
            <ArrowRight size={16} />
          </Button>
        </div>
        {error ? (
          <p className="text-sm leading-5 text-destructive" role="alert">
            {translateSiteError(t, error)}
          </p>
        ) : null}
      </form>
    </StartDiagnosticState>
  );
}
