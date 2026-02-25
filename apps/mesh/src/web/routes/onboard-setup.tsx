/**
 * Post-Login Onboarding Setup Page — /onboard-setup?token=<token>
 *
 * Shown after login (redirected from /login?next=/onboard-setup?token=<token>).
 * Resolves org options from the diagnostic token, lets the user create/join
 * an org, and claims the diagnostic session — completing the auth handoff flow.
 *
 * Auth check: handled internally (not via shell layout).
 * Token recovery: URL param (primary) → sessionStorage (OAuth fallback).
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearch, Navigate } from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

// ============================================================================
// Types
// ============================================================================

interface ResolveData {
  suggestedOrgName: string;
  storefrontUrl: string;
  matchingOrgs: Array<{
    id: string;
    name: string;
    memberCount: number;
  }>;
}

interface ClaimResult {
  organizationSlug: string;
  organizationId: string;
}

// ============================================================================
// Spinner icon
// ============================================================================

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
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

// ============================================================================
// Loading skeleton
// ============================================================================

function SetupSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading setup">
      <div className="h-6 w-48 rounded bg-muted" />
      <div className="h-4 w-64 rounded bg-muted" />
      <div className="mt-6 rounded-xl border border-border bg-card p-6">
        <div className="h-5 w-40 rounded bg-muted" />
        <div className="mt-2 h-4 w-56 rounded bg-muted" />
        <div className="mt-4 h-10 w-32 rounded bg-muted" />
      </div>
    </div>
  );
}

// ============================================================================
// Create org card
// ============================================================================

function CreateOrgCard({
  suggestedOrgName,
  token,
  onClaim,
  isPending,
  error,
}: {
  suggestedOrgName: string;
  token: string;
  onClaim: (body: { token: string; action: "create"; orgName: string }) => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <h2 className="text-base font-semibold text-foreground">
        Create your team
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        We suggest naming it after your company
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <span className="text-sm font-medium text-foreground">
          {suggestedOrgName}
        </span>
      </div>
      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          onClaim({ token, action: "create", orgName: suggestedOrgName })
        }
        className={cn(
          "mt-4 flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {isPending ? (
          <>
            <SpinnerIcon className="h-4 w-4 text-brand-foreground" />
            Creating team...
          </>
        ) : (
          "Create team"
        )}
      </button>
    </div>
  );
}

// ============================================================================
// Join org card
// ============================================================================

function JoinOrgCard({
  org,
  token,
  onClaim,
  isPending,
  error,
}: {
  org: { id: string; name: string; memberCount: number };
  token: string;
  onClaim: (body: { token: string; action: "join"; orgId: string }) => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{org.name}</p>
          <p className="text-xs text-muted-foreground">
            {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
          </p>
        </div>
        <button
          type="button"
          disabled={isPending}
          onClick={() => onClaim({ token, action: "join", orgId: org.id })}
          className={cn(
            "shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isPending ? "Joining..." : "Join"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Main page
// ============================================================================

export default function OnboardSetupPage() {
  const { token: urlToken } = useSearch({ from: "/onboard-setup" });

  // Token recovery: URL param (primary) → sessionStorage (OAuth redirect fallback)
  const token =
    urlToken ||
    (typeof window !== "undefined"
      ? sessionStorage.getItem(LOCALSTORAGE_KEYS.onboardingToken())
      : null);

  const session = authClient.useSession();

  const [claimError, setClaimError] = useState<string | null>(null);

  const { data: resolveData, isLoading: resolveLoading } =
    useQuery<ResolveData>({
      queryKey: KEYS.onboardingResolve(token ?? ""),
      queryFn: () =>
        fetch(`/api/onboarding/resolve?token=${encodeURIComponent(token ?? "")}`)
          .then((r) => {
            if (r.status === 401) {
              // Session expired — will be handled by redirect below
              throw new Error("UNAUTHORIZED");
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          }),
      enabled: !!token && !!session.data,
      retry: false,
    });

  const claimMutation = useMutation<
    ClaimResult,
    Error,
    { token: string; action: "create" | "join"; orgId?: string; orgName?: string }
  >({
    mutationFn: (body) =>
      fetch("/api/onboarding/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      }),
    onSuccess: (data) => {
      // Clean up sessionStorage token after successful claim
      if (typeof window !== "undefined") {
        sessionStorage.removeItem(LOCALSTORAGE_KEYS.onboardingToken());
      }
      // Redirect to the org dashboard
      window.location.href = `/${data.organizationSlug}`;
    },
    onError: (err) => {
      setClaimError(err.message ?? "Something went wrong. Please try again.");
    },
  });

  // ── Guard: not authenticated ─────────────────────────────────────────────
  if (!session.isPending && !session.data) {
    const loginUrl = token
      ? `/login?next=${encodeURIComponent(`/onboard-setup?token=${token}`)}`
      : "/login";
    return <Navigate to={loginUrl as "/"} />;
  }

  // ── Guard: no diagnostic token ───────────────────────────────────────────
  if (!session.isPending && session.data && !token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold text-foreground">
            No diagnostic report found
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Start a new storefront diagnostic to get your report and set up your
            team.
          </p>
          <a
            href="/onboarding"
            className="mt-6 inline-flex items-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
          >
            Run a diagnostic
          </a>
        </div>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (session.isPending || resolveLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg">
          <div className="mb-6 flex items-center gap-3">
            <SpinnerIcon className="h-5 w-5 text-brand" />
            <p className="text-sm font-medium text-muted-foreground">
              Setting up your workspace...
            </p>
          </div>
          <SetupSkeleton />
        </div>
      </div>
    );
  }

  // ── Error: resolve failed (e.g. 404) ─────────────────────────────────────
  if (!resolveData) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold text-foreground">
            Report not found or expired
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This diagnostic report may have expired or been already claimed.
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

  // ── Main UI ───────────────────────────────────────────────────────────────
  const handleClaim = (body: {
    token: string;
    action: "create" | "join";
    orgId?: string;
    orgName?: string;
  }) => {
    setClaimError(null);
    claimMutation.mutate(body);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">
            Your Storefront Report
          </h1>
          <p className="mt-1 text-sm text-muted-foreground break-all">
            {resolveData.storefrontUrl}
          </p>
        </div>

        {/* Create org */}
        <CreateOrgCard
          suggestedOrgName={resolveData.suggestedOrgName}
          token={token!}
          onClaim={handleClaim}
          isPending={
            claimMutation.isPending &&
            claimMutation.variables?.action === "create"
          }
          error={
            claimMutation.variables?.action === "create" ? claimError : null
          }
        />

        {/* Join existing orgs (if any matching) */}
        {resolveData.matchingOrgs.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 border-t border-border" />
              <span className="text-xs text-muted-foreground">
                or join an existing team
              </span>
              <div className="flex-1 border-t border-border" />
            </div>
            <div className="space-y-3">
              {resolveData.matchingOrgs.map((org) => (
                <JoinOrgCard
                  key={org.id}
                  org={org}
                  token={token!}
                  onClaim={handleClaim}
                  isPending={
                    claimMutation.isPending &&
                    claimMutation.variables?.action === "join" &&
                    claimMutation.variables?.orgId === org.id
                  }
                  error={
                    claimMutation.variables?.action === "join" &&
                    claimMutation.variables?.orgId === org.id
                      ? claimError
                      : null
                  }
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
