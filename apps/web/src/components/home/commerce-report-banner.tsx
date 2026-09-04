/**
 * Home report banner — surfaces the Commerce Discovery diagnostic on the
 * Overview for projects that own an onboarded store report, and opens the
 * project's canonical Reports destination.
 *
 * A miniature report page bleeds out of the banner's clipped bottom edge,
 * slightly tilted, and straightens on hover. While the run is live the page
 * shimmers and the copy says so; once the deck exists the page shows a score
 * ring and the arrow invites the click. State comes live from
 * `get_my_diagnostic` (see hooks/commerce-diagnostic-status.ts), polled gently
 * only while generating.
 *
 * Orgs without the Commerce Discovery connection never get past the first
 * (cheap, self-tool) gate: the banner renders nothing and no client to the
 * external MCP is ever created. Every failure path also renders nothing —
 * home must never break because of this banner.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ErrorBoundary } from "@/components/error-boundary";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { track } from "@/lib/posthog-client";
import { useCommerceDiagnostic } from "@/hooks/use-commerce-diagnostic";
import {
  type CommerceReportBannerStatus,
  deriveCommerceReportBannerStatus,
} from "@/hooks/commerce-diagnostic-status";
import { useT } from "@/i18n/use-t";
import { MiniReportPage } from "./mini-report-page";

function BannerShell({
  status,
  host,
  onOpen,
}: {
  status: Exclude<CommerceReportBannerStatus, "none">;
  host: string | null;
  onOpen: () => void;
}) {
  const t = useT();
  const generating = status === "generating";
  const store = host ?? t("reports.commerceBanner.storeDefault");

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative block w-full cursor-pointer overflow-hidden rounded-3xl border border-border bg-card card-shadow text-left",
        "transition-colors duration-300 hover:bg-accent/30",
        "animate-in fade-in slide-in-from-bottom-2 duration-500",
      )}
    >
      {/* atmosphere: a soft glow rising from behind the page */}
      <div
        aria-hidden
        className={cn(
          "absolute -bottom-24 -left-10 size-64 rounded-full blur-3xl transition-colors duration-700",
          generating ? "bg-warning/15" : "bg-success/15",
        )}
      />
      <MiniReportPage
        generating={generating}
        className={cn(
          // Decorative: hidden below sm so the copy keeps the full width.
          "absolute -bottom-14 left-6 hidden h-48 w-36 -rotate-6 sm:block",
          "transition-transform duration-500 ease-out group-hover:-translate-y-2 group-hover:-rotate-3",
        )}
      />
      {/* pl steps up to clear the decorative page once it appears at sm. */}
      <div className="relative flex min-h-28 items-center gap-4 px-5 py-5 sm:h-36 sm:gap-6 sm:pr-6 sm:pl-52">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-base font-medium leading-6 text-foreground sm:text-lg">
            {generating
              ? t("reports.commerceBanner.generatingTitle")
              : t("reports.commerceBanner.readyTitle")}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {generating
              ? t("reports.commerceBanner.generatingSubtitle", { store })
              : t("reports.commerceBanner.readySubtitle", { store })}
          </span>
        </div>
        <div
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-background",
            "transition-transform duration-300 group-hover:translate-x-1",
          )}
        >
          {generating ? (
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
            </span>
          ) : (
            <ArrowRight size={18} className="text-foreground" aria-hidden />
          )}
        </div>
      </div>
    </button>
  );
}

function CommerceReportBannerInner({ projectId }: { projectId: string }) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { diagnostic, isSuccess, host } = useCommerceDiagnostic(projectId);

  const status = isSuccess
    ? deriveCommerceReportBannerStatus(diagnostic)
    : "none";
  if (status === "none") return null;

  const openReport = () => {
    track("home_report_banner_clicked", {
      organization_id: org.id,
      project_id: projectId,
      status,
      domain: host ?? undefined,
    });
    navigate({
      to: PROJECT_ROUTE.reports,
      params: { org: org.slug, agentId: projectId },
      search: {},
    });
  };

  return <BannerShell status={status} host={host} onOpen={openReport} />;
}

export function CommerceReportBanner({ projectId }: { projectId: string }) {
  return (
    <ErrorBoundary fallback={null}>
      <CommerceReportBannerInner projectId={projectId} />
    </ErrorBoundary>
  );
}
