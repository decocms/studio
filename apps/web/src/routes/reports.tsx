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
import { DECK } from "./reports/templates/tokens";
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

/** GET /site/:domain shouldn't 401 anymore (see `apps/api/.../reports.ts`),
 *  but if it ever does — an edge case, not the normal unauthenticated path —
 *  refresh the session and drop back to the login gate instead of a dead-end
 *  error screen. */
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
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
      }}
    >
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/35" />
      <div className="relative z-10 flex min-h-full items-center justify-center px-4 py-10">
        {/* DECK tokens, not the app's theme variables: the deck is a fixed-light
            paper surface, but `.dark` lives on <html> above it, so `bg-background`
            here painted a black card on white paper for anyone in dark mode. The
            auth card solves the same problem by pinning the variables to their
            light values; this card has no shadcn children to inherit them, so it
            just uses the deck palette directly. */}
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
            className="mt-6 inline-flex h-11 items-center justify-center rounded-full px-6 text-sm font-medium transition-transform duration-300 ease-out hover:scale-[1.03]"
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

  // Unauthenticated too: the backend returns the cover slide of an
  // already-completed scan without a session — see `ScanGate`/`SignalDeck`
  // for where navigating past it prompts login.
  const initial = useQuery({
    queryKey: KEYS.report(domain, key, language),
    queryFn: () => getReport(domain, key, language),
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

  const content = initial.isPending ? (
    // Bare stage while the (unauthenticated-capable) read resolves —
    // ScanGate takes over with the full scanning UI, or the deck renders.
    <div className="fixed inset-0 overflow-hidden" aria-busy="true">
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/35" />
    </div>
  ) : reportUnauthorized ? (
    <UnauthorizedReportGate
      domain={domain}
      refreshSession={() => void session.refetch()}
    />
  ) : initial.isError ? (
    <ReportLoadError domain={domain} retry={() => void initial.refetch()} />
  ) : initial.data.status === "ready" ? (
    // A completed scan exists — render it straight away, even before login
    // has resolved. Unauthenticated visitors only get the cover slide; see
    // `SignalDeck`'s `authenticated` gating for what happens past it.
    // Keyed on `truncated`: once an in-place login (see `auth-gate.tsx`'s
    // `onAuthenticated`) refetches this query and gets back the full deck,
    // the key flips and ScanGate/SignalDeck remount fresh onto it instead of
    // clinging to the truncated one-slide deck they mounted with.
    <ScanGate
      key={String(Boolean(initial.data.truncated))}
      domain={domain}
      initial={initial.data}
      sessionEmail={session.data?.user?.email ?? ""}
      sessionUser={session.data?.user}
      lang={language}
      authenticated={authenticated}
    />
  ) : session.isPending ? (
    <ReportAuthGate domain={domain} loading />
  ) : !authenticated ? (
    // No completed scan yet, and anonymous visitors can't start one.
    <ReportAuthGate domain={domain} />
  ) : (
    <ScanGate
      domain={domain}
      initial={initial.data}
      sessionEmail={session.data?.user?.email ?? ""}
      sessionUser={session.data?.user}
      lang={language}
      authenticated={authenticated}
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
