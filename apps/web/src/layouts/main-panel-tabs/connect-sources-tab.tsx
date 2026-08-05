/**
 * ConnectSourcesTab — reopens the commerce-onboarding connect flow for a
 * client who already finished onboarding but skipped one or more data
 * sources (GA4/GSC/VTEX). Opened via the report app's
 * `studio://navigate?main=connect-sources` resource link (see
 * project-app-navigate.ts) — a dismissable overlay tab, unlike the blocking
 * onboarding step (CommerceConnectModal), sharing the same provider-card UI
 * and chrome (ConnectLayout) so the two don't drift.
 */
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@/sdk";
import {
  CompanionMcpsSection,
  CompanionMcpsSectionSkeleton,
} from "@/routes/commerce-onboarding/companion-mcps-section.tsx";
import {
  ConnectFooterButton,
  ConnectLayout,
} from "@/routes/commerce-onboarding/connect-layout.tsx";
import { parseSelfToolResult } from "@/routes/commerce-onboarding/self-tool-result.ts";

function ConnectSourcesTabError({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <ConnectLayout onClose={onClose} footer={null}>
      <p className="text-sm text-muted-foreground">
        {t("routes.commerceOnboarding.connectModal.loadError")}
      </p>
    </ConnectLayout>
  );
}

export function ConnectSourcesTab() {
  const navigate = useNavigate();
  const close = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: 0 as const,
      }),
      replace: true,
    });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ErrorBoundary
        fallback={() => <ConnectSourcesTabError onClose={close} />}
      >
        <Suspense
          fallback={
            <ConnectLayout onClose={close} footer={null}>
              <CompanionMcpsSectionSkeleton />
            </ConnectLayout>
          }
        >
          <ConnectSourcesTabContent onDone={close} onClose={close} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function ConnectSourcesTabContent({
  onDone,
  onClose,
}: {
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
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
  const siteUrl =
    typeof item?.metadata?.siteUrl === "string"
      ? (item.metadata.siteUrl as string)
      : undefined;

  // Starts false (unlike the onboarding modal, which fails open): here the
  // client is already past onboarding, so there's no forced-continue path —
  // the refresh CTA should stay disabled until a source actually connects.
  const [hasConnectedSource, setHasConnectedSource] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

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

  const refreshReport = async () => {
    setRunError(null);
    if (siteUrl) {
      try {
        await runMutation.mutateAsync(siteUrl);
      } catch {
        setRunError(
          t("routes.commerceOnboarding.connectModal.somethingWentWrong"),
        );
        return;
      }
    }
    onDone();
  };

  return (
    <ConnectLayout
      onClose={onClose}
      footer={
        <>
          {runError ? (
            <p className="text-sm leading-5 text-destructive" role="alert">
              {runError}
            </p>
          ) : null}
          <ConnectFooterButton
            ready={hasConnectedSource}
            pending={runMutation.isPending}
            label={
              runMutation.isPending
                ? t("routes.commerceOnboarding.connectSourcesTab.refreshing")
                : t("routes.commerceOnboarding.connectSourcesTab.refresh")
            }
            onClick={() => void refreshReport()}
          />
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto">
        <h2 className="text-xl font-medium leading-tight text-foreground">
          {t("routes.commerceOnboarding.connectSourcesTab.title")}
        </h2>
        <CompanionMcpsSection
          org={org}
          cdConnectionId={connectionId}
          siteUrl={siteUrl}
          onReadinessChange={setHasConnectedSource}
        />
      </div>
    </ConnectLayout>
  );
}
