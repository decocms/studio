/**
 * Provisional-claim topbar for the Commerce Discovery report tab.
 *
 * Shown only while the org's claim on the store is PROVISIONAL (reports
 * PR #313: the ownership ladder graded the claim instead of blocking it —
 * e.g. a gmail login). A slim, full-width yellow strip above the report:
 * clicking it opens the connect-sources tab, where connecting GA4/GSC
 * verifies the claim automatically (the binding proves access to the
 * domain's own property).
 *
 * Fail-soft by construction: no siteUrl, a loading/failed status query, a
 * worker that predates the `claim` field, or a verified claim all render
 * nothing. The report must never break because of this strip.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "@untitledui/icons";
import {
  mcpClientQueryOptions,
  SELF_MCP_ALIAS_ID,
  useProjectContext,
} from "@/sdk";
import { ErrorBoundary } from "@/components/error-boundary";
import { useCommerceDiagnostic } from "@/hooks/use-commerce-diagnostic";
import { useT } from "@/i18n/use-t";
import { usePanelActions } from "@/layouts/shell-layout";
import { KEYS } from "@/lib/query-keys";
import { unwrapToolResult } from "@/routes/commerce-onboarding/companions-core";

interface ConnectionStatusResult {
  claim?: { method: string | null; verified: boolean } | null;
}

function CommerceClaimBannerInner() {
  const { org } = useProjectContext();
  const { siteUrl } = useCommerceDiagnostic();
  const { openTab } = usePanelActions();
  const t = useT();

  const { data: selfClient } = useQuery(
    mcpClientQueryOptions({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  );

  // Same key + tool as the connect-sources cards, so the caches cooperate and
  // a binding write over there invalidates this strip too.
  const statusQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryConnectionStatus(org.id, siteUrl ?? ""),
    enabled: !!siteUrl && !!selfClient,
    queryFn: async () => {
      if (!selfClient) throw new Error("selfClient not ready");
      const result = await selfClient.callTool({
        name: "COMMERCE_DISCOVERY_CONNECTION_STATUS",
        arguments: { siteUrl },
      });
      return unwrapToolResult<ConnectionStatusResult>(result);
    },
  });

  const claim = statusQuery.data?.claim;
  if (!claim || claim.verified) return null;

  return (
    <button
      type="button"
      onClick={() => openTab("connect-sources")}
      className="flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 bg-warning px-3 py-1.5 text-xs font-medium text-black transition-opacity hover:opacity-90"
    >
      <span>{t("reports.claimBanner.provisional")}</span>
      <ArrowRight className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}

export function CommerceClaimBanner() {
  return (
    <ErrorBoundary fallback={null}>
      <CommerceClaimBannerInner />
    </ErrorBoundary>
  );
}
