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
import { ArrowRight } from "@untitledui/icons";
import { Suspense, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  normalizeReportsSiteUrl,
  siteUrlToHost,
} from "@decocms/shared/reports/site-url";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { useCommerceDiagnostic } from "@/hooks/use-commerce-diagnostic";
import { MiniReportPage } from "@/components/home/mini-report-page";
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

/** What the diagnostic looks at. Concrete enough to be worth the wait, short
 *  enough to scan — the report itself covers far more. */
const CHECK_KEYS = [
  "reports.emptyState.checkPerformance",
  "reports.emptyState.checkSeo",
  "reports.emptyState.checkFunnel",
  "reports.emptyState.checkTracking",
] as const;

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
    <div className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-6">
      {/* The report you don't have yet, tilted under its own glow. */}
      <div className="relative flex items-end justify-center pt-4">
        <div
          aria-hidden
          className="absolute -bottom-6 size-56 rounded-full bg-success/10 blur-3xl"
        />
        <MiniReportPage className="relative h-52 w-40 -rotate-6" />
        <MiniReportPage className="relative -ml-14 h-56 w-44 rotate-3" />
      </div>

      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-lg font-medium leading-7 text-foreground">
          {t("reports.emptyState.title")}
        </h2>
        <p className="max-w-sm text-sm leading-5 text-muted-foreground">
          {t("reports.emptyState.description")}
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col items-center gap-4">
        {children ??
          (host ? (
            <p className="text-sm text-muted-foreground">{host}</p>
          ) : null)}
        <ul className="flex flex-wrap items-center justify-center gap-2">
          {CHECK_KEYS.map((key) => (
            <li
              key={key}
              className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
            >
              {t(key)}
            </li>
          ))}
        </ul>
      </div>
    </div>
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
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
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
          <Button
            type="submit"
            className="shrink-0"
            disabled={setupMutation.isPending}
          >
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
