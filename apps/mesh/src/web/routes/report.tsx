/**
 * Diagnostic Report Page — /report/$token
 *
 * Public page (no auth required). Loads the persisted diagnostic session
 * by token and renders a structured report with 4 real data sections:
 * - Performance (Core Web Vitals)
 * - SEO (on-page signals, crawlability)
 * - Tech Stack (platform, analytics, CDN, etc.)
 * - Company Context (AI-generated description with edit affordance)
 */

import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { DiagnosticSession } from "@/diagnostic/types";
import { PerformanceSection } from "@/web/components/report/performance-section";
import { SeoSection } from "@/web/components/report/seo-section";
import { TechStackSection } from "@/web/components/report/tech-stack-section";
import { CompanyContextSection } from "@/web/components/report/company-context-section";
import { ShareButton } from "@/web/components/report/share-button";
import { TrafficSection } from "@/web/components/report/traffic-section";
import { SeoRankingsSection } from "@/web/components/report/seo-rankings-section";
import { BrandSection } from "@/web/components/report/brand-section";
import { PercentileSection } from "@/web/components/report/percentile-section";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

// ============================================================================
// Loading skeleton
// ============================================================================

function ReportSkeleton() {
  return (
    <div
      className="animate-pulse space-y-8"
      aria-busy="true"
      aria-label="Loading report"
    >
      <div className="h-8 w-64 rounded bg-muted" />
      <div className="h-4 w-48 rounded bg-muted" />
      <div className="space-y-3">
        <div className="h-4 w-full rounded bg-muted" />
        <div className="h-4 w-5/6 rounded bg-muted" />
        <div className="h-4 w-4/6 rounded bg-muted" />
      </div>
      <div className="space-y-3">
        <div className="h-4 w-full rounded bg-muted" />
        <div className="h-4 w-5/6 rounded bg-muted" />
      </div>
    </div>
  );
}

// ============================================================================
// Not found state
// ============================================================================

function ReportNotFound({ token }: { token: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-foreground">Report Not Found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No diagnostic report found for token{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
            {token}
          </code>
          . Reports expire after 7 days.
        </p>
        <a
          href="/onboarding"
          className="mt-6 inline-flex items-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
        >
          Run a new diagnostic
        </a>
      </div>
    </div>
  );
}

// ============================================================================
// Date formatting helper
// ============================================================================

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return isoString;
  }
}

// ============================================================================
// Login/signup CTA
// ============================================================================

function SignupCTA({ token }: { token: string }) {
  const session = authClient.useSession();

  // Store token in sessionStorage as fallback for OAuth redirects
  // that may strip query params during multi-step redirect chains.
  // This runs on every render — sessionStorage is synchronous and fast.
  if (typeof window !== "undefined") {
    sessionStorage.setItem(LOCALSTORAGE_KEYS.onboardingToken(), token);
  }

  // Don't show CTA if user is already logged in
  if (session.data) {
    return null;
  }

  const loginUrl = `/login?next=${encodeURIComponent(`/onboard-setup?token=${token}`)}`;

  return (
    <div className="rounded-xl border-2 border-brand/30 bg-brand/5 p-6 text-center">
      <h3 className="text-lg font-semibold text-foreground">
        Save this report to your team
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Sign up to keep this diagnostic, track improvements over time, and
        unlock AI-powered recommendations for your store.
      </p>
      <a
        href={loginUrl}
        className="mt-4 inline-flex items-center rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
      >
        Sign up free
      </a>
    </div>
  );
}

// ============================================================================
// Report page
// ============================================================================

export default function ReportPage() {
  const { token } = useParams({ from: "/report/$token" });

  const {
    data: session,
    isLoading,
    isError,
  } = useQuery<DiagnosticSession>({
    queryKey: KEYS.diagnosticSession(token),
    queryFn: () =>
      fetch(`/api/diagnostic/session/${token}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    // No refetchInterval — data is persisted, single fetch is sufficient
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <ReportSkeleton />
        </div>
      </div>
    );
  }

  if (isError || !session) {
    return <ReportNotFound token={token} />;
  }

  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <main className="mx-auto max-w-4xl">
        {/* Report header */}
        <header className="mb-10 flex items-start justify-between gap-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground">
              Storefront Diagnostic Report
            </h1>
            <p className="mt-1 text-base text-muted-foreground break-all">
              {session.url}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Analyzed on {formatDate(session.createdAt)}
            </p>
          </div>
          <div className="shrink-0 pt-1">
            <ShareButton />
          </div>
        </header>

        {/* Report sections */}
        <div className="space-y-12">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <PerformanceSection data={session.results?.webPerformance} />
          </div>

          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <SeoSection data={session.results?.seo} />
          </div>

          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <TechStackSection data={session.results?.techStack} />
          </div>

          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <CompanyContextSection data={session.results?.companyContext} />
          </div>

          <TrafficSection />
          <SeoRankingsSection />
          <BrandSection />
          <PercentileSection />

          {/* Login CTA */}
          <SignupCTA token={token} />
        </div>

        {/* Footer */}
        <footer className="mt-12 border-t border-border pt-6 text-center text-xs text-muted-foreground">
          <p>
            This report was generated automatically.{" "}
            <a
              href="/onboarding"
              className="underline hover:text-foreground transition-colors"
            >
              Run another diagnostic
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}
