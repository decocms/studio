import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  brandFromDomain,
  faviconForDomain,
  normalizeDomain,
  reportShareCopy,
} from "@decocms/shared/report-seo";
import { KEYS } from "@/lib/query-keys";
import { authClient } from "@/lib/auth-client";
import { isPostHogInitialized } from "@/lib/posthog-client";
import { getReport } from "./reports/api";
import ScanGate from "./reports/scan-gate";
import { DECK } from "./reports/tokens";
import {
  captureReport,
  consumeReportAuthAttempt,
  REPORT_SURFACE,
  reportAuthAttemptProperties,
} from "./reports/track";
import { useT } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import "./reports/reports.css";

const route = getRouteApi("/report/$domain");

/**
 * Swap the browser-tab title + favicon to the scanned domain's own. The SPA
 * shell ships static decocms tags; this is the client-side override (crawler
 * unfurls are handled server-side by the head-rewrite route). Restores the
 * originals on unmount.
 */
function domainChromeRef(
  domain: string,
  title: string,
  apiFaviconUrl?: string,
) {
  return (el: HTMLDivElement | null) => {
    if (!el || !domain) return;
    const prevTitle = document.title;
    document.title = title;

    const href = apiFaviconUrl || faviconForDomain(domain, 64);
    const head = document.head;
    // Neutralize (don't remove) the existing icon links so we don't fight
    // React-managed head nodes — flipping `rel` to an inert value avoids
    // orphaning nodes and leaking this favicon onto the next route.
    const disabled = Array.from(
      head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
    ).filter((n) => !n.hasAttribute("data-domain-favicon"));
    disabled.forEach((n) => {
      n.dataset.prevRel = n.getAttribute("rel") ?? "";
      n.setAttribute("rel", "decocms-icon-disabled");
    });

    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.href = href;
    icon.setAttribute("data-domain-favicon", "");
    head.appendChild(icon);

    return () => {
      document.title = prevTitle;
      icon.remove();
      disabled.forEach((n) => {
        n.setAttribute("rel", n.dataset.prevRel ?? "icon");
        delete n.dataset.prevRel;
      });
    };
  };
}

function ReportLoadError({ retry }: { retry: () => void }) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{
        background: DECK.bg,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
      }}
    >
      <div className="relative z-10 flex min-h-full items-center justify-center px-4 py-10">
        {/* DECK tokens, not the app's theme variables: this is a fixed-light
            paper surface, but `.dark` lives on <html> above it. */}
        <section
          role="alert"
          aria-label={t("routes.reports.failedToLoadReportAriaLabel")}
          className="w-full max-w-[440px] rounded-3xl px-7 py-8 card-shadow"
          style={{ background: DECK.surface, color: DECK.ink }}
        >
          <h1 className="text-xl font-medium leading-7">
            {t("routes.reports.failedToLoadReportTitle")}
          </h1>
          <p className="mt-2 text-sm leading-6" style={{ color: DECK.muted }}>
            {t("routes.reports.failedToLoadReportDescription")}
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-6 inline-flex h-11 items-center justify-center classic:rounded-full compact:rounded-lg px-6 text-sm font-medium transition-transform duration-300 ease-out hover:scale-[1.03]"
            style={{ background: DECK.primary, color: DECK.primaryFg }}
          >
            {t("routes.reports.retryButton")}
          </button>
        </section>
      </div>
    </div>
  );
}

export default function ReportPage() {
  const { domain: rawDomain } = route.useParams();
  const domain = normalizeDomain(rawDomain);
  const session = authClient.useSession();
  const authenticated = Boolean(session.data?.user);
  // The viewer's Studio locale, so a language switch reflects in the report.
  const [{ language }] = usePreferences();

  // No session needed: published reports are public and anyone can start a scan.
  const initial = useQuery({
    queryKey: KEYS.report(domain, language),
    queryFn: () => getReport(domain, language),
    staleTime: Infinity,
    retry: 1,
  });

  const report = initial.data?.report ?? null;
  const { title } = reportShareCopy({
    brand: report?.brand.trim() || brandFromDomain(domain),
    domain,
    score: report?.score,
  });

  const authCompletionRef = (element: HTMLDivElement | null) => {
    if (
      !element ||
      !authenticated ||
      element.dataset.authCompletionTracked === "true" ||
      !isPostHogInitialized()
    )
      return;
    const attempt = consumeReportAuthAttempt(domain);
    if (!attempt) return;
    element.dataset.authCompletionTracked = "true";
    captureReport("report_auth_succeeded", {
      domain,
      surface: REPORT_SURFACE,
      ...reportAuthAttemptProperties(attempt),
      method: attempt.method ?? "unknown",
      time_to_auth_ms: Math.max(0, Date.now() - attempt.gate_shown_at),
      ...(attempt.provider ? { provider: attempt.provider } : {}),
      ...(attempt.auth_mode ? { auth_mode: attempt.auth_mode } : {}),
    });
  };

  const content = initial.isPending ? (
    <div
      className="fixed inset-0"
      style={{ background: DECK.bg }}
      aria-busy="true"
    />
  ) : initial.isError ? (
    <ReportLoadError retry={() => void initial.refetch()} />
  ) : (
    <ScanGate
      domain={domain}
      initial={initial.data}
      sessionEmail={session.data?.user?.email ?? ""}
      lang={language}
    />
  );

  return (
    <div
      ref={(el) => {
        const cleanupChrome = domainChromeRef(
          domain,
          title,
          report?.favicon,
        )(el);
        authCompletionRef(el);
        return cleanupChrome;
      }}
    >
      {content}
    </div>
  );
}
