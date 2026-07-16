import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  brandFromDomain,
  faviconForDomain,
  normalizeDomain,
  reportShareCopy,
} from "@/shared/report-seo";
import { KEYS } from "@/web/lib/query-keys";
import { authClient } from "@/web/lib/auth-client";
import { isPostHogInitialized } from "@/web/lib/posthog-client";
import { getReport } from "./reports/api";
import { ReportAuthGate, ReportBackdrop } from "./reports/auth-gate";
import ScanGate from "./reports/scan-gate";
import {
  captureReport,
  consumeReportAuthAttempt,
  reportAuthAttemptProperties,
  setReportReviewerMode,
} from "./reports/track";
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

export default function ReportPage() {
  const { domain: rawDomain } = route.useParams();
  const { key } = route.useSearch();
  const domain = normalizeDomain(rawDomain);
  const session = authClient.useSession();
  const authenticated = Boolean(session.data?.user);

  // Reviewer sessions (?key=) flag every event with report_preview — set at
  // render (module state, so it lands before any child capture) and cleared
  // on unmount via the chrome ref below sharing the same lifecycle.
  setReportReviewerMode(Boolean(key));

  const initial = useQuery({
    queryKey: KEYS.report(domain, key),
    queryFn: () => getReport(domain, key),
    enabled: authenticated,
    staleTime: Infinity,
    retry: 1,
  });

  const brand =
    initial.data?.deck?.meta.brand?.trim() || brandFromDomain(domain);
  const { title } = reportShareCopy({ brand, domain });

  const reviewerCleanupRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    setReportReviewerMode(Boolean(key));
    return () => setReportReviewerMode(false);
  };

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
  ) : initial.isPending ? (
    // Bare stage while the authenticated read resolves — ScanGate takes over
    // with the full scanning UI (or the deck renders when ready).
    <div className="fixed inset-0 overflow-hidden" aria-busy="true">
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/35" />
    </div>
  ) : (
    <ScanGate
      domain={domain}
      initial={initial.data}
      sessionEmail={session.data.user.email}
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
