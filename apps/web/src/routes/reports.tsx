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
import { getReport, isReportsUnauthorized } from "./reports/api";
import { ReportAuthGate, ReportBackdrop } from "./reports/auth-gate";
import ScanGate from "./reports/scan-gate";
import {
  captureReport,
  consumeReportAuthAttempt,
  reportAuthAttemptProperties,
  setReportReviewerMode,
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
      head.querySelectorAll<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="apple-touch-icon"]',
      ),
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

function UnauthorizedReportGate({
  domain,
  refreshSession,
}: {
  domain: string;
  refreshSession: () => void;
}) {
  const refreshSessionRef = (element: HTMLDivElement | null) => {
    if (!element || element.dataset.sessionRefreshStarted === "true") return;
    element.dataset.sessionRefreshStarted = "true";
    refreshSession();
  };

  return (
    <div ref={refreshSessionRef}>
      <ReportAuthGate domain={domain} />
    </div>
  );
}

function ReportLoadError({
  domain,
  retry,
}: {
  domain: string;
  retry: () => void;
}) {
  const t = useT();
  return (
    <div className="fixed inset-0 overflow-y-auto">
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/35" />
      <div className="relative z-10 flex min-h-full items-center justify-center px-4 py-10">
        <section
          role="alert"
          aria-label={t("routes.reports.failedToLoadReportAriaLabel")}
          className="w-full max-w-[440px] rounded-3xl bg-background px-7 py-8 text-foreground shadow-2xl"
        >
          <h1 className="text-xl font-medium leading-7">
            {t("routes.reports.failedToLoadReportTitle")}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t("routes.reports.failedToLoadReportDescription")}
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-6 inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
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
  const { key } = route.useSearch();
  const domain = normalizeDomain(rawDomain);
  const session = authClient.useSession();
  const authenticated = Boolean(session.data?.user);
  // Render the deck in the viewer's Studio locale (same source as the rest of
  // the UI's i18n), so a language switch reflects in the report too.
  const [{ language }] = usePreferences();

  // Reviewer sessions (?key=) flag every event with report_preview — set at
  // render (module state, so it lands before any child capture) and cleared
  // on unmount via the chrome ref below sharing the same lifecycle.
  setReportReviewerMode(Boolean(key));

  const initial = useQuery({
    queryKey: KEYS.report(domain, key, language),
    queryFn: () => getReport(domain, key, language),
    enabled: authenticated,
    staleTime: Infinity,
    retry: (failureCount, error) =>
      !isReportsUnauthorized(error) && failureCount < 1,
  });
  const reportUnauthorized =
    initial.isError && isReportsUnauthorized(initial.error);

  const brand =
    initial.data?.deck?.meta.brand?.trim() || brandFromDomain(domain);
  // Keep the browser-tab title in step with the crawler card (score + verdict).
  const { title } = reportShareCopy({
    brand,
    domain,
    score: initial.data?.deck?.meta.scores?.cover,
  });

  const reviewerCleanupRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    setReportReviewerMode(Boolean(key));
    return () => setReportReviewerMode(false);
  };

  const authCompletionRef = (element: HTMLDivElement | null) => {
    if (
      !element ||
      !authenticated ||
      reportUnauthorized ||
      element.dataset.authCompletionTracked === "true" ||
      !isPostHogInitialized()
    )
      return;
    const attempt = consumeReportAuthAttempt(domain);
    if (!attempt) return;
    element.dataset.authCompletionTracked = "true";
    captureReport("report_auth_succeeded", {
      domain,
      surface: "deck_v2",
      ...reportAuthAttemptProperties(attempt),
      method: attempt.method ?? "unknown",
      time_to_auth_ms: Math.max(0, Date.now() - attempt.gate_shown_at),
      ...(attempt.provider ? { provider: attempt.provider } : {}),
      ...(attempt.auth_mode ? { auth_mode: attempt.auth_mode } : {}),
    });
  };

  const content = session.isPending ? (
    <ReportAuthGate domain={domain} loading />
  ) : !session.data?.user ? (
    <ReportAuthGate domain={domain} />
  ) : reportUnauthorized ? (
    <UnauthorizedReportGate
      domain={domain}
      refreshSession={() => void session.refetch()}
    />
  ) : initial.isPending ? (
    // Bare stage while the authenticated read resolves — ScanGate takes over
    // with the full scanning UI (or the deck renders when ready).
    <div className="fixed inset-0 overflow-hidden" aria-busy="true">
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/35" />
    </div>
  ) : initial.isError ? (
    <ReportLoadError domain={domain} retry={() => void initial.refetch()} />
  ) : (
    <ScanGate
      domain={domain}
      initial={initial.data}
      sessionEmail={session.data.user.email}
      sessionUser={session.data.user}
      lang={language}
    />
  );

  return (
    <div
      ref={(el) => {
        const cleanupChrome = domainChromeRef(
          domain,
          title,
          initial.data?.deck?.meta.faviconUrl,
        )(el);
        const cleanupReviewer = reviewerCleanupRef(el);
        authCompletionRef(el);
        return () => {
          cleanupChrome?.();
          cleanupReviewer?.();
        };
      }}
    >
      {content}
    </div>
  );
}
