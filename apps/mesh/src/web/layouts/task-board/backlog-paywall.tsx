/**
 * Board paywall banner — a persistent strip at the top of the task board for
 * commerce orgs whose diagnostic is still locked (unpaid).
 *
 * The board itself stays fully usable: the user can create and run their own
 * tasks freely. What's paywalled is the auto-generated plano de trabalho — the
 * diagnostic run computes it but withholds the push until the org unlocks the
 * enriched diagnostic (see commerce-skills). This banner is the in-product CTA
 * for that unlock; it reads the diagnostic's `locked` flag, so it clears itself
 * the moment payment lands. Renders nothing for non-commerce orgs, orgs without
 * a diagnostic, or once unlocked.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Lightning01 } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  commerceReportNavTarget,
  useCommerceDiagnostic,
} from "@/web/hooks/use-commerce-diagnostic";
import { track } from "@/web/lib/posthog-client";

function BacklogPaywallBannerInner() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { diagnostic, connectionId } = useCommerceDiagnostic();

  // Only while the diagnostic exists and is still locked (unpaid).
  if (!diagnostic?.locked) return null;

  const openReport = () => {
    track("board_paywall_banner_clicked", { organization_id: org.id });
    navigate(commerceReportNavTarget(org, connectionId));
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-card px-4 py-3 card-shadow">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10">
        <Lightning01 size={16} className="text-success" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">
          Seu plano de trabalho completo está bloqueado
        </span>
        <span className="text-sm text-muted-foreground">
          Desbloqueie o diagnóstico e as tarefas priorizadas entram no quadro,
          da maior prioridade para a menor.
        </span>
      </div>
      <Button size="sm" className="shrink-0 gap-2" onClick={openReport}>
        Desbloquear diagnóstico
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}

export function BacklogPaywallBanner() {
  return (
    <ErrorBoundary fallback={null}>
      <BacklogPaywallBannerInner />
    </ErrorBoundary>
  );
}
