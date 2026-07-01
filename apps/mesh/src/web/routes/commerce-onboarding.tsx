import { normalizeCommerceSiteUrl } from "@/commerce-discovery/site-url";
import { AuthEntry } from "@/web/components/auth-entry";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { AuthSplitLayout } from "@/web/components/auth-split-layout";
import { OrganizationChoice } from "@/web/components/organization-choice";
import { ScrollReveal } from "@/web/components/scroll-reveal";
import { formatPinnedViewTabId } from "@/web/layouts/main-panel-tabs/tab-id";
import {
  authClient,
  invalidateOrganizationListCache,
  useActiveOrganizations,
} from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  getCommerceDiscoveryAgentId,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import {
  QueryErrorResetBoundary,
  useMutation,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Loading01 } from "@untitledui/icons";
import { createContext, Suspense, useContext, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CompanionMcpsSection } from "./commerce-onboarding/companion-mcps-section.tsx";
import {
  buildScheduleMeetingUrl,
  ScheduleMeetingBanner,
  ScheduleMeetingVisual,
} from "./commerce-onboarding/schedule-meeting.tsx";
import { SiteBadge } from "./commerce-onboarding/site-badge.tsx";

interface CommerceOrganization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  joinMode?: "auto" | "request";
}

interface EnsureOrganizationResponse {
  success: boolean;
  status?:
    | "created"
    | "joined"
    | "already_has_organization"
    | "ambiguous"
    | "skipped";
  organization?: CommerceOrganization;
  organizations?: CommerceOrganization[];
  domain?: string | null;
  reason?: string;
  error?: string;
}

interface CollectionGetResult<T = unknown> {
  item: T | null;
}

interface CommerceDiscoveryReportApp {
  connectionId: string;
  virtualMcpId: string;
  toolName: typeof COMMERCE_DISCOVERY_REPORT_TOOL_NAME;
}

interface CommerceDiscoverySetupResult {
  reportApp?: CommerceDiscoveryReportApp;
}

interface SelfToolResult {
  structuredContent?: unknown;
  isError?: boolean;
  content?: Array<{ text?: string }>;
}

export default function CommerceOnboardingRoute() {
  return <CommerceOnboardingPage />;
}

/**
 * Hostname derived from the `siteUrl` query param (e.g. "fila.com.br"),
 * provided to the whole onboarding experience so every header renders the
 * deco + site badge. `null` when no valid `siteUrl` is present.
 */
const CommerceSiteHostContext = createContext<string | null>(null);

const useCommerceSiteHost = () => useContext(CommerceSiteHostContext);

function siteUrlToHost(siteUrl?: string): string | null {
  if (!siteUrl) return null;
  const normalized = normalizeCommerceSiteUrl(siteUrl);
  return normalized.ok ? new URL(normalized.value).hostname : null;
}

function CommerceOnboardingPage() {
  const search = useSearch({ from: "/commerce-onboarding" });
  const { org: requestedOrgSlug, siteUrl } = search;
  const siteHost = siteUrlToHost(siteUrl);

  return (
    <CommerceSiteHostContext.Provider value={siteHost}>
      <CommerceOnboardingScreens
        requestedOrgSlug={requestedOrgSlug}
        siteUrl={siteUrl}
      />
    </CommerceSiteHostContext.Provider>
  );
}

function CommerceOnboardingScreens({
  requestedOrgSlug,
  siteUrl,
}: {
  requestedOrgSlug?: string;
  siteUrl?: string;
}) {
  const { data: session, isPending: sessionLoading } = authClient.useSession();
  const siteHost = useCommerceSiteHost();

  if (sessionLoading) {
    return (
      <AuthSplitLayout>
        <LoadingState label="Preparing commerce onboarding..." />
      </AuthSplitLayout>
    );
  }

  if (!session) {
    const callbackUrl =
      typeof window === "undefined"
        ? "/commerce-onboarding"
        : `${window.location.pathname}${window.location.search}`;

    return (
      <AuthSplitLayout>
        <AuthEntry
          callbackUrl={callbackUrl}
          allowAutoLogin={false}
          title="Unlock your full diagnostic"
          subtitle={null}
          brand={siteHost ? <SiteBadge host={siteHost} /> : undefined}
        />
      </AuthSplitLayout>
    );
  }

  return (
    <CommerceOnboardingContent
      requestedOrgSlug={requestedOrgSlug}
      siteUrl={siteUrl}
    />
  );
}

function CommerceOnboardingContent({
  requestedOrgSlug,
  siteUrl,
}: {
  requestedOrgSlug?: string;
  siteUrl?: string;
}) {
  const navigate = useNavigate();
  const organizationsQuery = useActiveOrganizations();
  const [selectedOrg, setSelectedOrg] = useState<CommerceOrganization | null>(
    null,
  );
  const [settledEnsureResult, setSettledEnsureResult] =
    useState<EnsureOrganizationResponse | null>(null);

  const activeOrganizations: CommerceOrganization[] =
    organizationsQuery.data?.map((org: CommerceOrganization) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo ?? null,
    })) ?? [];

  const ensureOrganizationMutation = useMutation({
    mutationFn: async (): Promise<EnsureOrganizationResponse> => {
      const res = await fetch("/api/auth/custom/ensure-organization", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json()) as EnsureOrganizationResponse;
      if (
        data.success &&
        (data.status === "created" ||
          data.status === "joined" ||
          data.status === "already_has_organization") &&
        data.organization
      ) {
        invalidateOrganizationListCache();
      }
      return data;
    },
    retry: false,
    onSuccess: (data) => {
      setSettledEnsureResult(data);
    },
  });

  if (organizationsQuery.isPending) {
    return (
      <AuthSplitLayout>
        <LoadingState label="Preparing commerce onboarding..." />
      </AuthSplitLayout>
    );
  }

  if (organizationsQuery.error) {
    return (
      <CommerceErrorState
        title="We could not load your organizations"
        description="Retry to continue commerce setup from this page."
        actionLabel="Retry"
        onRetry={() => organizationsQuery.refetch()}
      />
    );
  }

  const requestedOrg = requestedOrgSlug
    ? activeOrganizations.find((org) => org.slug === requestedOrgSlug)
    : null;

  if (requestedOrg) {
    return <CommerceSetup org={requestedOrg} initialSiteUrl={siteUrl} />;
  }

  if (requestedOrgSlug) {
    return (
      <CommerceErrorState
        title="Organization not found"
        description="We could not find that organization for your account."
        actionLabel="Retry"
        onRetry={() => organizationsQuery.refetch()}
      />
    );
  }

  if (selectedOrg) {
    return <CommerceSetup org={selectedOrg} initialSiteUrl={siteUrl} />;
  }

  if (activeOrganizations.length === 1 && activeOrganizations[0]) {
    return (
      <CommerceSetup org={activeOrganizations[0]} initialSiteUrl={siteUrl} />
    );
  }

  if (activeOrganizations.length > 1) {
    return (
      <AuthSplitLayout>
        <div className="grid gap-10">
          <CommerceHeader
            title="Choose an organization"
            description="Select where commerce diagnostics should continue."
          />
          <ScrollReveal className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
            <OrganizationChoice
              organizations={activeOrganizations}
              selectLabel="Continue"
              onSelected={(organization) => setSelectedOrg(organization)}
            />
          </ScrollReveal>
        </div>
      </AuthSplitLayout>
    );
  }

  if (!settledEnsureResult) {
    return (
      <EnsureOrganizationRecovery
        mutation={ensureOrganizationMutation}
        onRetry={() => {
          ensureOrganizationMutation.reset();
          ensureOrganizationMutation.mutate();
        }}
      />
    );
  }

  const ensureResult = settledEnsureResult;

  if (
    ensureResult?.success &&
    (ensureResult.status === "created" ||
      ensureResult.status === "joined" ||
      ensureResult.status === "already_has_organization") &&
    ensureResult.organization
  ) {
    return (
      <CommerceSetup org={ensureResult.organization} initialSiteUrl={siteUrl} />
    );
  }

  if (
    ensureResult?.status === "ambiguous" &&
    ensureResult.organizations &&
    ensureResult.organizations.length > 0
  ) {
    return (
      <AuthSplitLayout>
        <div className="grid gap-10">
          <CommerceHeader
            title="Choose an organization"
            description="Your email can access more than one organization. Choose where commerce setup should continue."
          />
          <ScrollReveal className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
            <OrganizationChoice
              organizations={ensureResult.organizations}
              domain={ensureResult.domain ?? undefined}
              onJoined={(organization, slug) => {
                invalidateOrganizationListCache();
                setSelectedOrg({ ...organization, slug });
                navigate({
                  to: "/commerce-onboarding",
                  search: { org: slug, siteUrl },
                });
              }}
            />
          </ScrollReveal>
        </div>
      </AuthSplitLayout>
    );
  }

  return (
    <CommerceErrorState
      title="Commerce onboarding needs support"
      description={
        ensureResult?.error ??
        "We could not determine a commerce organization for this account."
      }
      actionLabel="Try again"
      onRetry={() => {
        setSettledEnsureResult(null);
        ensureOrganizationMutation.reset();
      }}
    />
  );
}

function EnsureOrganizationRecovery({
  mutation,
  onRetry,
}: {
  mutation: ReturnType<typeof useMutation<EnsureOrganizationResponse, Error>>;
  onRetry: () => void;
}) {
  const startedRef = useRef(false);

  const triggerRecovery = (node: HTMLDivElement | null) => {
    if (!node || startedRef.current) return;
    // Callback ref keeps the automatic recovery trigger out of render without
    // using useEffect, which is banned in this React 19 app.
    startedRef.current = true;
    mutation.mutate();
  };

  if (mutation.error) {
    return (
      <CommerceErrorState
        title="Commerce onboarding is unavailable"
        description="We could not prepare an organization for commerce setup. Retry from this page or contact support."
        actionLabel="Retry"
        onRetry={onRetry}
      />
    );
  }

  return (
    <AuthSplitLayout>
      <div ref={triggerRecovery}>
        <LoadingState label="Preparing your commerce workspace..." />
      </div>
    </AuthSplitLayout>
  );
}

function CommerceHeader({
  title,
  description,
}: {
  title?: string;
  description?: string;
}) {
  const siteHost = useCommerceSiteHost();
  return (
    <div className="grid gap-10">
      {siteHost ? (
        <SiteBadge host={siteHost} />
      ) : (
        <div>
          <img
            src="/logos/deco logo.svg"
            alt="Deco"
            className="h-12 w-12 dark:hidden"
          />
          <img
            src="/logos/deco logo negative.svg"
            alt="Deco"
            className="h-12 w-12 hidden dark:block"
          />
        </div>
      )}
      {(title || description) && (
        <div className="space-y-2">
          {title && <h1 className="text-2xl font-medium leading-8">{title}</h1>}
          {description && (
            <p className="text-base text-muted-foreground leading-6">
              {description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 py-4"
      role="status"
      aria-live="polite"
    >
      <Loading01 size={14} className="animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

function CommerceErrorState({
  title,
  description,
  actionLabel,
  onRetry,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onRetry: () => void;
}) {
  return (
    <AuthSplitLayout>
      <div className="grid gap-10">
        <CommerceHeader title={title} description={description} />
        <Button type="button" size="xl" className="w-full" onClick={onRetry}>
          {actionLabel}
        </Button>
      </div>
    </AuthSplitLayout>
  );
}

function getToolErrorMessage(result: SelfToolResult): string {
  return (
    result.content?.find((item) => item.text)?.text ??
    "Commerce Discovery setup failed."
  );
}

function parseSelfToolResult<T>(result: unknown): T {
  const toolResult = result as SelfToolResult;
  if (toolResult.isError) {
    throw new Error(getToolErrorMessage(toolResult));
  }
  return (toolResult.structuredContent ?? result) as T;
}

function CommerceSetup({
  org,
  initialSiteUrl,
}: {
  org: CommerceOrganization;
  initialSiteUrl?: string;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          fallback={({ error, resetError }) => (
            <AuthSplitLayout>
              <CommerceSetupErrorState
                orgName={org.name}
                message={
                  error instanceof Error
                    ? error.message
                    : "We could not check Commerce Discovery setup."
                }
                onRetry={() => {
                  reset();
                  resetError();
                }}
              />
            </AuthSplitLayout>
          )}
        >
          <Suspense
            fallback={
              <AuthSplitLayout>
                <LoadingState label="Connecting workspace..." />
              </AuthSplitLayout>
            }
          >
            <CommerceSetupContent
              key={`${org.id}:${initialSiteUrl ?? ""}`}
              org={org}
              initialSiteUrl={initialSiteUrl}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function CommerceSetupErrorState({
  orgName,
  message,
  onRetry,
}: {
  orgName: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid gap-10">
      <CommerceHeader
        title="Commerce diagnostics"
        description={`Commerce setup will continue for ${orgName}.`}
      />
      <InlineError message={message} />
      <Button type="button" size="xl" className="w-full" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function CommerceSetupContent({
  org,
  initialSiteUrl,
}: {
  org: CommerceOrganization;
  initialSiteUrl?: string;
}) {
  const navigate = useNavigate();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [siteUrlInput, setSiteUrlInput] = useState(initialSiteUrl ?? "");
  const [setupResult, setSetupResult] =
    useState<CommerceDiscoverySetupResult | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const autoSetupStartedRef = useRef(false);

  const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);
  const virtualMcpId = getCommerceDiscoveryAgentId(org.id);

  const connectionQuery = useSuspenseQuery({
    queryKey: KEYS.commerceDiscoveryConnection(org.id, connectionId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: connectionId },
      });
      return parseSelfToolResult<CollectionGetResult>(result);
    },
    retry: false,
  });

  const virtualMcpQuery = useSuspenseQuery({
    queryKey: KEYS.commerceDiscoveryVirtualMcp(org.id, virtualMcpId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "COLLECTION_VIRTUAL_MCP_GET",
        arguments: { id: virtualMcpId },
      });
      return parseSelfToolResult<CollectionGetResult>(result);
    },
    retry: false,
  });

  const setupMutation = useMutation({
    mutationFn: async (siteUrl: string) => {
      const result = await selfClient.callTool({
        name: "COMMERCE_DISCOVERY_SETUP",
        arguments: { siteUrl },
      });
      return parseSelfToolResult<CommerceDiscoverySetupResult>(result);
    },
    retry: false,
    onSuccess: (result) => {
      setSetupResult(result);
      setInlineError(null);
      void connectionQuery.refetch();
      void virtualMcpQuery.refetch();
    },
    onError: (error) => {
      setInlineError(
        error instanceof Error
          ? error.message
          : "Commerce Discovery setup failed.",
      );
    },
  });

  const setupReady = !!connectionQuery.data.item && !!virtualMcpQuery.data.item;

  const runSetup = (rawSiteUrl: string) => {
    const normalized = normalizeCommerceSiteUrl(rawSiteUrl);
    if (!normalized.ok) {
      setInlineError(normalized.error);
      return;
    }
    setInlineError(null);
    setupMutation.mutate(normalized.value);
  };

  const triggerInitialSetup = (node: HTMLDivElement | null) => {
    if (!node || autoSetupStartedRef.current || setupReady || !initialSiteUrl) {
      return;
    }

    autoSetupStartedRef.current = true;
    runSetup(initialSiteUrl);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runSetup(siteUrlInput);
  };

  const reportApp = setupResult?.reportApp ?? {
    connectionId,
    virtualMcpId,
    toolName: COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  };

  const openReport = () => {
    localStorage.setItem(
      LOCALSTORAGE_KEYS.sidebarOpen(),
      JSON.stringify(false),
    );
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId: crypto.randomUUID() },
      search: {
        virtualmcpid: reportApp.virtualMcpId,
        main: formatPinnedViewTabId(reportApp.connectionId, reportApp.toolName),
        chat: 0,
      },
    });
  };

  if (setupReady) {
    return (
      <CommerceDiscoveryReady
        org={org}
        reportApp={reportApp}
        onOpenReport={openReport}
        siteUrl={initialSiteUrl ?? siteUrlInput}
      />
    );
  }

  if (initialSiteUrl) {
    const normalized = normalizeCommerceSiteUrl(initialSiteUrl);

    if (!normalized.ok) {
      return (
        <AuthSplitLayout>
          <div className="grid gap-10">
            <CommerceHeader
              title="Commerce diagnostics"
              description={`Commerce setup will continue for ${org.name}.`}
            />
            <InlineError message={normalized.error} />
            <SiteUrlForm
              siteUrl={siteUrlInput}
              error={inlineError}
              isSubmitting={setupMutation.isPending}
              onSiteUrlChange={setSiteUrlInput}
              onSubmit={handleSubmit}
            />
          </div>
        </AuthSplitLayout>
      );
    }

    return (
      <AuthSplitLayout>
        <div ref={triggerInitialSetup} className="grid gap-10">
          <CommerceHeader
            title="Commerce diagnostics"
            description={`Commerce Discovery is being prepared for ${normalized.value}.`}
          />
          {inlineError ? (
            <>
              <InlineError message={inlineError} />
              <SiteUrlForm
                siteUrl={siteUrlInput}
                error={null}
                isSubmitting={setupMutation.isPending}
                onSiteUrlChange={setSiteUrlInput}
                onSubmit={handleSubmit}
              />
            </>
          ) : (
            <LoadingState label="Setting up Commerce Discovery..." />
          )}
        </div>
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout>
      <div className="grid gap-10">
        <CommerceHeader
          title="Commerce diagnostics"
          description={`Commerce setup will continue for ${org.name}.`}
        />
        <SiteUrlForm
          siteUrl={siteUrlInput}
          error={inlineError}
          isSubmitting={setupMutation.isPending}
          onSiteUrlChange={setSiteUrlInput}
          onSubmit={handleSubmit}
        />
      </div>
    </AuthSplitLayout>
  );
}

function SiteUrlForm({
  siteUrl,
  error,
  isSubmitting,
  onSiteUrlChange,
  onSubmit,
}: {
  siteUrl: string;
  error: string | null;
  isSubmitting: boolean;
  onSiteUrlChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="commerce-site-url">
          Website URL
        </label>
        <Input
          id="commerce-site-url"
          type="text"
          inputMode="url"
          value={siteUrl}
          onChange={(event) => onSiteUrlChange(event.target.value)}
          placeholder="https://example.com"
          aria-invalid={!!error}
          disabled={isSubmitting}
        />
        {error ? <InlineError message={error} /> : null}
      </div>
      <Button
        type="submit"
        size="xl"
        className="w-full"
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loading01 size={14} className="animate-spin" />
            Setting up
          </>
        ) : (
          <>
            Continue
            <ArrowRight size={16} />
          </>
        )}
      </Button>
    </form>
  );
}

function CommerceDiscoveryReady({
  org,
  reportApp,
  onOpenReport,
  siteUrl,
}: {
  org: CommerceOrganization;
  reportApp: CommerceDiscoveryReportApp;
  onOpenReport: () => void;
  siteUrl?: string;
}) {
  const { data: session } = authClient.useSession();
  const meetingUrl = buildScheduleMeetingUrl({
    siteUrl,
    email: session?.user?.email,
  });
  return (
    // The "connect your tools" screen is the only one that swaps the placeholder
    // visual for the schedule-a-meeting panel (md+); every other setup screen
    // keeps the default AuthSplitLayout placeholder.
    <AuthSplitLayout
      align="top"
      visual={<ScheduleMeetingVisual href={meetingUrl} />}
    >
      {/* Mobile: fill the viewport (minus AuthSplitLayout's pt-4+pb-8 = 3rem) as a
          flex column — header pinned top, cards scroll in the middle, and the
          footer (report CTA + talk-to-a-human banner) pinned to the bottom.
          align="top" avoids the vh/dvh centering that used to clip the footer.
          On md+ it collapses back to a natural block (right panel has the card). */}
      <div className="flex h-[calc(100dvh-3rem)] flex-col gap-6 md:block md:h-auto">
        <CommerceHeader />
        <CompanionMcpsSection
          org={org}
          cdConnectionId={reportApp.connectionId}
        />
        <div className="flex shrink-0 flex-col gap-3 md:mt-8">
          {/* Right-side ScheduleMeetingVisual is hidden on mobile, so the human
              escape hatch rides in the footer above the report CTA. */}
          <ScheduleMeetingBanner className="md:hidden" href={meetingUrl} />
          <Button
            type="button"
            size="xl"
            className="w-full rounded-2xl text-base font-medium"
            onClick={onOpenReport}
            disabled={!reportApp.virtualMcpId}
          >
            See full report
            <ArrowRight size={18} />
          </Button>
        </div>
      </div>
    </AuthSplitLayout>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="text-sm leading-5 text-destructive" role="alert">
      {message}
    </p>
  );
}
