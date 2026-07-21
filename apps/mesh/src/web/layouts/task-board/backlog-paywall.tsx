/**
 * Board paywall CTA — shown in place of the empty state for commerce
 * (reports-only) orgs whose plano de trabalho hasn't been generated yet.
 *
 * The backlog is paid content: the diagnostic run computes it but withholds the
 * push to this board until the org unlocks the enriched diagnostic (see
 * commerce-skills task-sync / the Stripe unlock). So an empty commerce board is
 * the "not unlocked yet" state — this card turns it into a second paywall
 * surface (the report deck being the first), opening the report app where the
 * unlock lives. Once unlocked, the backlog lands and this card is replaced by
 * the cards themselves.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Lightning01 } from "@untitledui/icons";
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getCommerceDiscoveryAgentId,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { formatPinnedViewTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import { track } from "@/web/lib/posthog-client";

export function BacklogPaywall() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);

  const openReport = () => {
    track("board_paywall_cta_clicked", { organization_id: org.id });
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId: crypto.randomUUID() },
      search: {
        virtualmcpid: getCommerceDiscoveryAgentId(org.id),
        main: formatPinnedViewTabId(
          connectionId,
          COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
        ),
      },
    });
  };

  return (
    <div className="relative flex flex-col items-center gap-5 overflow-hidden rounded-xl bg-card px-6 py-12 text-center card-shadow">
      {/* soft glow to lift the card without a raw palette */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 left-1/2 size-56 -translate-x-1/2 rounded-full bg-success/15 blur-3xl"
      />
      <div className="relative flex size-12 items-center justify-center rounded-full border border-border bg-background">
        <Lightning01 size={22} className="text-success" />
      </div>
      <div className="relative flex max-w-md flex-col gap-2">
        <h2 className="text-lg font-medium text-foreground">
          Gere seu plano de trabalho
        </h2>
        <p className="text-sm text-muted-foreground">
          Desbloqueie seu diagnóstico enriquecido com dados privados e gere seu
          plano de trabalho. As tarefas priorizadas caem direto aqui no quadro,
          prontas para você executar ou delegar.
        </p>
      </div>
      <Button className="relative gap-2" onClick={openReport}>
        Desbloquear diagnóstico
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}
