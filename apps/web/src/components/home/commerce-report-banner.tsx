/**
 * Home report banner — surfaces the Commerce Discovery diagnostic on the
 * Overview for orgs that onboarded a store, and opens the report app.
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
import { cn } from "@deco/ui/lib/utils.ts";
import { ErrorBoundary } from "@/components/error-boundary";
import { track } from "@/lib/posthog-client";
import {
  commerceReportNavTarget,
  useCommerceDiagnostic,
} from "@/hooks/use-commerce-diagnostic";
import {
  type CommerceReportBannerStatus,
  deriveCommerceReportBannerStatus,
} from "@/hooks/commerce-diagnostic-status";
import { useT } from "@/i18n/use-t";

/** The tilted miniature report page bleeding out of the banner's bottom
 *  edge. Pure decoration (aria-hidden); `generating` swaps the score ring
 *  and chart for shimmering placeholders. */
function MiniReportPage({ generating }: { generating: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        // Decorative — hidden below sm so it never crowds the copy on narrow
        // screens; the text reclaims the full width there.
        "pointer-events-none absolute -bottom-14 left-6 hidden h-48 w-36 -rotate-6 rounded-xl border border-border bg-background shadow-lg sm:block",
        "transition-transform duration-500 ease-out group-hover:-translate-y-2 group-hover:-rotate-3",
      )}
    >
      <div className="flex h-full flex-col gap-3 p-4">
        {/* page header: score ring + title lines */}
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-9 shrink-0 -rotate-90">
            <circle
              cx="16"
              cy="16"
              r="12"
              fill="none"
              strokeWidth="4"
              className="stroke-muted"
            />
            <circle
              cx="16"
              cy="16"
              r="12"
              fill="none"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="75.4"
              strokeDashoffset={generating ? "75.4" : "22"}
              className={cn(
                "transition-[stroke-dashoffset] duration-1000 ease-out",
                generating ? "stroke-muted" : "stroke-success",
              )}
            />
          </svg>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div
              className={cn(
                "h-1.5 w-full rounded-full bg-muted",
                generating && "animate-pulse",
              )}
            />
            <div
              className={cn(
                "h-1.5 w-2/3 rounded-full bg-muted",
                generating && "animate-pulse",
              )}
            />
          </div>
        </div>
        {/* mini bar chart */}
        <div className="flex h-10 items-end gap-1.5">
          {[7, 10, 5, 9, 6, 8].map((h, i) => (
            <div
              key={`bar-${i}`}
              style={{ height: `${h * 4}px` }}
              className={cn(
                "flex-1 rounded-sm",
                generating
                  ? "animate-pulse bg-muted"
                  : i % 2 === 0
                    ? "bg-success/70"
                    : "bg-success/30",
              )}
            />
          ))}
        </div>
        {/* body lines running past the clipped edge */}
        <div className="flex flex-col gap-1.5">
          {["w-full", "w-5/6", "w-full", "w-2/3", "w-full"].map((w, i) => (
            <div
              key={`line-${i}`}
              className={cn(
                "h-1.5 rounded-full bg-muted",
                w,
                generating && "animate-pulse",
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

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
      <MiniReportPage generating={generating} />
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

function CommerceReportBannerInner() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { diagnostic, isSuccess, host, connectionId } = useCommerceDiagnostic();

  const status = isSuccess
    ? deriveCommerceReportBannerStatus(diagnostic)
    : "none";
  if (status === "none") return null;

  const openReport = () => {
    track("home_report_banner_clicked", {
      organization_id: org.id,
      status,
      domain: host ?? undefined,
    });
    navigate(commerceReportNavTarget(org, connectionId));
  };

  return <BannerShell status={status} host={host} onOpen={openReport} />;
}

export function CommerceReportBanner() {
  return (
    <ErrorBoundary fallback={null}>
      <CommerceReportBannerInner />
    </ErrorBoundary>
  );
}
