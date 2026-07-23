import { normalizeReportsSiteUrl, siteUrlToHost } from "@/reports/site-url";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { authClient } from "@/web/lib/auth-client";
import { useT } from "@/web/i18n/use-t.ts";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { track } from "@/web/lib/posthog-client";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { formatPinnedViewTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getCommerceDiscoveryAgentId,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "@untitledui/icons";
import { Suspense, useState } from "react";
import {
  CompanionMcpsSection,
  CompanionMcpsSectionSkeleton,
} from "./companion-mcps-section.tsx";
import {
  buildScheduleMeetingUrl,
  ScheduleMeetingBanner,
  ScheduleMeetingVisual,
} from "./schedule-meeting.tsx";
import { parseSelfToolResult } from "./self-tool-result.ts";
import { SiteBadge } from "./site-badge.tsx";

/**
 * Blocking commerce-onboarding connections step, rendered as a modal OVER the
 * org (the report page behind it stays mounted and blurred) instead of as a
 * standalone `/commerce-onboarding` screen. Non-dismissable: no close button, no
 * escape/overlay close — the only way forward is connecting at least one data
 * source, which enables the "Ver relatório completo" CTA. `onComplete` is called
 * once the run is triggered so the caller can drop the `connect` search param and
 * reveal the report.
 */
export function CommerceConnectModal({ siteUrl }: { siteUrl?: string }) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const t = useT();

  // Completing the connect step opens the diagnostic report in a fresh thread.
  // That navigation also drops the `?connect=1` param, which unmounts this modal
  // and reveals the report. Target end state: the Commerce Discovery report app
  // open in the main panel, with chat (`sidepanel: 0`, overriding the report
  // agent's chatDefaultOpen) and the sidebar both closed.
  const goToReport = () => {
    localStorage.setItem(
      LOCALSTORAGE_KEYS.sidebarOpen(),
      JSON.stringify(false),
    );
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId: crypto.randomUUID() },
      search: {
        virtualmcpid: getCommerceDiscoveryAgentId(org.id),
        main: formatPinnedViewTabId(
          WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id),
          COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
        ),
        sidepanel: 0,
      },
    });
  };

  return (
    <Dialog open>
      <DialogPortal>
        <DialogOverlay className="bg-black/15 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-slot="commerce-connect-modal"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex h-[calc(100dvh-1rem)] w-full max-w-[calc(100%-1rem)] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-2xl border p-0 shadow-md duration-200 sm:max-w-lg md:h-auto md:max-h-[calc(100dvh-2rem)] lg:max-h-[calc(100dvh-4rem)] lg:max-w-5xl"
        >
          <DialogTitle className="sr-only">
            {t("routes.commerceOnboarding.connectModal.dialogTitle")}
          </DialogTitle>
          <ErrorBoundary
            fallback={() => (
              <div className="grid gap-4 p-6">
                <p className="text-sm text-muted-foreground">
                  {t("routes.commerceOnboarding.connectModal.loadError")}
                </p>
                <Button
                  type="button"
                  size="xl"
                  className="w-full"
                  onClick={goToReport}
                >
                  {t("routes.commerceOnboarding.connectModal.continueButton")}
                  <ArrowRight size={18} />
                </Button>
              </div>
            )}
          >
            <Suspense fallback={<CompanionMcpsSectionSkeleton />}>
              <CommerceConnectModalContent
                siteUrlFromUrl={siteUrl}
                onComplete={goToReport}
              />
            </Suspense>
          </ErrorBoundary>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function CommerceConnectModalContent({
  siteUrlFromUrl,
  onComplete,
}: {
  siteUrlFromUrl?: string;
  onComplete: () => void;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const connectionQuery = useSuspenseQuery({
    queryKey: KEYS.commerceDiscoveryConnection(org.id, connectionId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: connectionId },
      });
      return parseSelfToolResult<{
        item: { metadata?: Record<string, unknown> | null } | null;
      }>(result);
    },
    retry: false,
  });

  const item = connectionQuery.data.item;
  const metadataSiteUrl =
    typeof item?.metadata?.siteUrl === "string"
      ? (item.metadata.siteUrl as string)
      : undefined;
  // Prefer the site from the URL (same context as /commerce-onboarding?siteUrl=…);
  // fall back to the connection's stored metadata for returning sessions.
  const siteUrl = siteUrlFromUrl || metadataSiteUrl;
  const siteHost = siteUrlToHost(siteUrl);

  // Fails open: the CTA stays usable unless the companions section positively
  // confirms there are required sources still unconnected. A section load error
  // shouldn't be able to permanently trap the user behind a disabled button.
  const [hasConnectedSource, setHasConnectedSource] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);

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
  const runMutation = useMutation({
    mutationFn: async (url: string) =>
      parseSelfToolResult<{ triggered: boolean; reason?: string }>(
        await selfClient.callTool({
          name: "COMMERCE_DISCOVERY_RUN",
          arguments: { siteUrl: url },
        }),
      ),
    retry: false,
  });

  const meetingUrl = buildScheduleMeetingUrl({
    siteUrl,
    email: session?.user?.email,
    locale: preferences.language,
  });

  const openReport = async () => {
    setRunError(null);
    // The onboarding-completion intent: the click, not the report render.
    track("commerce_onboarding_open_report_clicked", {
      domain: siteHost ?? undefined,
      organization_id: org.id,
    });
    // Trigger the enriching run now that the user is done connecting. We await it
    // so a failure surfaces (generic message, modal stays put) instead of
    // silently revealing an empty report. No resolvable site ⇒ nothing to
    // trigger, just proceed.
    const normalized = siteUrl ? normalizeReportsSiteUrl(siteUrl) : null;
    if (normalized?.ok) {
      try {
        let runResult = await runMutation.mutateAsync(normalized.value);
        // triggered:false means the site isn't claimed for this org on the
        // Commerce Discovery side (not_upgraded). Reconcile by re-running setup
        // (idempotent /upgrade re-claims the site AND refreshes the token), then
        // retry the run once before giving up.
        if (!runResult.triggered) {
          track("commerce_onboarding_run_reclaim", {
            domain: siteHost ?? undefined,
            organization_id: org.id,
            reason: runResult.reason ?? "not_upgraded",
          });
          await setupMutation.mutateAsync(normalized.value);
          runResult = await runMutation.mutateAsync(normalized.value);
        }
        if (!runResult.triggered) {
          track("commerce_onboarding_run_failed", {
            domain: siteHost ?? undefined,
            organization_id: org.id,
            error: runResult.reason ?? "not_triggered",
          });
          setRunError(
            t("routes.commerceOnboarding.connectModal.couldNotGenerateReport"),
          );
          return;
        }
      } catch (err) {
        track("commerce_onboarding_run_failed", {
          domain: siteHost ?? undefined,
          organization_id: org.id,
          error: err instanceof Error ? err.message : String(err),
        });
        setRunError(
          t("routes.commerceOnboarding.connectModal.somethingWentWrong"),
        );
        return;
      }
    }
    onComplete();
  };

  return (
    // Mobile: single flex column (header → scrolling cards → pinned footer with
    // the compact meeting banner + CTA). lg+: two columns — the connect column
    // on the left, the full meeting card on the right (the original split), with
    // the banner hidden since the card carries it. The left column always owns
    // the scroll + pinned CTA so the CTA stays reachable at short window heights.
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* Left column — matches the old page's bg-sidebar content panel. The
          companion section owns its own scroll (title pinned, cards scroll), so
          it goes here directly as the flex-1 child; no extra scroll wrapper. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:bg-sidebar lg:p-10">
        {siteHost ? <SiteBadge host={siteHost} /> : null}
        <CompanionMcpsSection
          org={org}
          cdConnectionId={connectionId}
          siteUrl={siteUrl}
          onReadinessChange={setHasConnectedSource}
        />
        <div className="flex shrink-0 flex-col gap-3">
          <ScheduleMeetingBanner
            href={meetingUrl}
            orgId={org.id}
            className="lg:hidden"
          />
          {runError ? (
            <p className="text-sm leading-5 text-destructive" role="alert">
              {runError}
            </p>
          ) : null}
          <Button
            type="button"
            size="xl"
            className="w-full rounded-2xl text-base font-medium whitespace-normal h-auto py-3"
            onClick={() => void openReport()}
            disabled={runMutation.isPending || !hasConnectedSource}
          >
            {runMutation.isPending
              ? t("routes.commerceOnboarding.connectModal.openingReport")
              : !hasConnectedSource
                ? t(
                    "routes.commerceOnboarding.connectModal.connectToolToContinue",
                  )
                : t("routes.commerceOnboarding.connectModal.viewFullReport")}
            {!runMutation.isPending && hasConnectedSource ? (
              <ArrowRight size={18} />
            ) : null}
          </Button>
        </div>
      </div>
      {/* Right panel — the old page's right side: divider, distinct bg-muted
          background, and the meeting card centered in the middle. Desktop only. */}
      <aside className="hidden lg:flex lg:w-[380px] lg:shrink-0 lg:items-center lg:justify-center lg:overflow-y-auto lg:border-l lg:border-border lg:bg-muted">
        <ScheduleMeetingVisual href={meetingUrl} orgId={org.id} />
      </aside>
    </div>
  );
}
