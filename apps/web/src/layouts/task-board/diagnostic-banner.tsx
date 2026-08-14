/**
 * Board ↔ diagnostic banner. Sits at the top of the task board for orgs that
 * onboarded a store, and is the board's side of the Commerce Discovery
 * integration: the diagnostic's findings are imported as cards by the reports
 * sync, and this banner says so — while the run is live, while the deck is
 * still locked (CTA: open the report app, where the unlock lives), and once
 * the fixes have landed.
 *
 * Orgs without the Commerce Discovery connection never pass
 * `useCommerceDiagnostic`'s first gate, so the banner renders nothing and no
 * client to the external MCP is created. Every failure path renders nothing too
 * — the board must stay usable regardless (hence the ErrorBoundary).
 *
 * State derivation lives in `diagnostic-banner-state.ts` (unit-tested).
 */

import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Lock01, Sparkles01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ErrorBoundary } from "@/components/error-boundary";
import { deriveCommerceReportBannerStatus } from "@/hooks/commerce-diagnostic-status";
import {
  commerceReportNavTarget,
  useCommerceDiagnostic,
} from "@/hooks/use-commerce-diagnostic";
import { useT } from "@/i18n/use-t";
import { track } from "@/lib/posthog-client";
import { useProjectContext } from "@/sdk";
import {
  deriveDiagnosticBannerState,
  type DiagnosticBannerKind,
} from "./diagnostic-banner-state";

function BannerShell({
  kind,
  store,
  taskCount,
  onOpen,
}: {
  kind: Exclude<DiagnosticBannerKind, "hidden">;
  store: string;
  taskCount: number;
  onOpen: () => void;
}) {
  const t = useT();

  const title =
    kind === "generating"
      ? t("taskBoard.diagnosticBanner.generatingTitle")
      : kind === "locked"
        ? t("taskBoard.diagnosticBanner.lockedTitle")
        : taskCount > 0
          ? t("taskBoard.diagnosticBanner.readyTitle", { count: taskCount })
          : t("taskBoard.diagnosticBanner.readyEmptyTitle");

  const description =
    kind === "generating"
      ? t("taskBoard.diagnosticBanner.generatingDescription", { store })
      : kind === "locked"
        ? t("taskBoard.diagnosticBanner.lockedDescription", { store })
        : taskCount > 0
          ? t("taskBoard.diagnosticBanner.readyDescription", { store })
          : t("taskBoard.diagnosticBanner.readyEmptyDescription", { store });

  const cta =
    kind === "locked"
      ? t("taskBoard.diagnosticBanner.unlockCta")
      : t("taskBoard.diagnosticBanner.viewReportCta");

  return (
    <div
      data-testid="board-diagnostic-banner"
      data-kind={kind}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 card-shadow",
        "animate-in fade-in slide-in-from-top-1 duration-500",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-background",
          kind === "generating" && "text-warning",
          kind === "locked" && "text-muted-foreground",
          kind === "ready" && "text-success",
        )}
      >
        {kind === "generating" ? (
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
          </span>
        ) : kind === "locked" ? (
          <Lock01 size={16} />
        ) : (
          <Sparkles01 size={16} />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="truncate text-sm text-muted-foreground">
          {description}
        </span>
      </div>

      <Button variant="outline" size="sm" onClick={onOpen}>
        {cta}
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}

function BoardDiagnosticBannerInner() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const t = useT();
  const { diagnostic, isSuccess, host, connectionId } = useCommerceDiagnostic();
  const { reportTaskCount } = useBoardReportTaskCount();

  const status = isSuccess
    ? deriveCommerceReportBannerStatus(diagnostic)
    : "none";
  const { kind, taskCount } = deriveDiagnosticBannerState({
    status,
    locked: diagnostic?.locked,
    reportTaskCount,
  });
  if (kind === "hidden") return null;

  return (
    <BannerShell
      kind={kind}
      store={host ?? t("reports.commerceBanner.storeDefault")}
      taskCount={taskCount}
      onOpen={() => {
        track("board_diagnostic_banner_clicked", {
          organization_id: org.id,
          kind,
          report_task_count: taskCount,
          domain: host ?? undefined,
        });
        navigate(commerceReportNavTarget(org, connectionId));
      }}
    />
  );
}

/** Report-sourced cards on the board, read from the same cached list the board
 *  renders (so the count follows SSE patches without a second request). */
function useBoardReportTaskCount() {
  const { items } = useTaskBoardItems();
  return {
    reportTaskCount: items.filter((item) => isReportsTask(item)).length,
  };
}

export function BoardDiagnosticBanner() {
  return (
    <ErrorBoundary fallback={null}>
      <BoardDiagnosticBannerInner />
    </ErrorBoundary>
  );
}
