/**
 * Storefront Diagnostic Onboarding Page
 *
 * Public page (no auth required). Two states:
 *   1. URL Input — collect the store URL and trigger a diagnostic scan
 *   2. Loading — show agent checklist, poll session status, navigate to report on completion
 */

import { useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@deco/ui/lib/utils.ts";
import { KEYS } from "@/web/lib/query-keys";
import type { DiagnosticAgentId, DiagnosticSession } from "@/diagnostic/types";

// ============================================================================
// Constants
// ============================================================================

const AGENT_DISPLAY_NAMES: Record<DiagnosticAgentId, string> = {
  web_performance: "Web Performance",
  seo: "SEO Analysis",
  tech_stack: "Tech Stack Detection",
  company_context: "Company Context",
};

const AGENT_ORDER: DiagnosticAgentId[] = [
  "web_performance",
  "seo",
  "tech_stack",
  "company_context",
];

// ============================================================================
// Sub-components
// ============================================================================

function SpinnerIcon() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-brand"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-4 w-4 text-success"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      className="h-4 w-4 text-destructive"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

function PendingIcon() {
  return (
    <span className="inline-block h-4 w-4 rounded-full border-2 border-border bg-muted" />
  );
}

// ============================================================================
// Loading state — agent checklist with session polling
// ============================================================================

function AgentChecklist({ token, url }: { token: string; url: string }) {
  const { data: session } = useQuery<DiagnosticSession>({
    queryKey: KEYS.diagnosticSession(token),
    queryFn: () =>
      fetch(`/api/diagnostic/session/${token}`).then((r) => r.json()),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed") return false;
      return 1500;
    },
  });

  // Navigate to report when session completes or fails
  if (session?.status === "completed" || session?.status === "failed") {
    return <Navigate to="/report/$token" params={{ token }} replace={false} />;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mb-3 flex items-center justify-center">
            <SpinnerIcon />
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            Analyzing your store
          </h1>
          <p className="mt-1 text-sm text-muted-foreground break-all">{url}</p>
        </div>

        {/* Agent checklist */}
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Running diagnostics
          </p>
          <ul className="space-y-3">
            {AGENT_ORDER.map((agentId) => {
              const agentStatus = session?.agents?.[agentId];
              const status = agentStatus?.status ?? "pending";

              return (
                <li key={agentId} className="flex items-center gap-3">
                  <span className="flex h-5 w-5 items-center justify-center">
                    {status === "completed" ? (
                      <CheckIcon />
                    ) : status === "failed" ? (
                      <XIcon />
                    ) : status === "running" ? (
                      <SpinnerIcon />
                    ) : (
                      <PendingIcon />
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-sm",
                      status === "completed" && "text-foreground",
                      status === "failed" && "text-destructive",
                      status === "running" && "font-medium text-foreground",
                      status === "pending" && "text-muted-foreground",
                    )}
                  >
                    {AGENT_DISPLAY_NAMES[agentId]}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          This usually takes 15-30 seconds
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// URL Input state
// ============================================================================

function UrlInputForm({
  onSubmit,
}: {
  onSubmit: (token: string, url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/diagnostic/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          setError(
            "Too many requests. Please wait a moment before trying again.",
          );
        } else {
          setError(data.error ?? "Something went wrong. Please try again.");
        }
        return;
      }

      onSubmit(data.token, url);
    } catch {
      setError("Could not connect to the server. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-brand to-brand/75 p-4">
      {/* Dot grid background */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(circle, var(--brand-foreground) 1px, transparent 1px)`,
          backgroundSize: "16px 16px",
          opacity: 0.15,
        }}
      />

      <div className="relative z-10 w-full max-w-md">
        {/* Blueprint lines */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-screen bg-brand-foreground/15" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 h-px w-screen bg-brand-foreground/15" />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-screen bg-brand-foreground/15" />
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-px h-screen bg-brand-foreground/15" />

        <div className="rounded-xl border border-brand-foreground/20 bg-background/95 p-8 shadow-2xl backdrop-blur-sm">
          {/* Logo / brand mark */}
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-foreground">
              Storefront Diagnostic
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Enter your store URL to get an instant performance report
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="store-url"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Store URL
              </label>
              <input
                id="store-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-store.com"
                required
                disabled={isSubmitting}
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-base text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-50"
              />
              {error && (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !url.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <SpinnerIcon />
                  Starting analysis...
                </>
              ) : (
                "Run Diagnostic"
              )}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            No account required &bull; Takes about 30 seconds
          </p>
        </div>
      </div>
    </main>
  );
}

// ============================================================================
// Page root — orchestrates input → loading → report navigation
// ============================================================================

export default function OnboardingPage() {
  const [scanState, setScanState] = useState<{
    token: string;
    url: string;
  } | null>(null);

  if (scanState) {
    return <AgentChecklist token={scanState.token} url={scanState.url} />;
  }

  return (
    <UrlInputForm onSubmit={(token, url) => setScanState({ token, url })} />
  );
}
