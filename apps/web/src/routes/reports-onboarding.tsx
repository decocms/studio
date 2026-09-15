import {
  isConnectionClaimedForSite,
  normalizeReportsSiteUrl,
  siteUrlToHost,
} from "@decocms/shared/reports/site-url";
import { AuthEntry } from "@/components/auth-entry";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { OrganizationChoice } from "@/components/organization-choice";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { ScrollReveal } from "@/components/scroll-reveal";
import {
  authClient,
  invalidateOrganizationListCache,
  useActiveOrganizations,
} from "@/lib/auth-client";
import { isPostHogInitialized, track } from "@/lib/posthog-client";
import { reportAttributionFromSearch } from "@/routes/reports/track";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  getReportsAgentId,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  WellKnownOrgMCPId,
} from "@/sdk";
import {
  QueryErrorResetBoundary,
  useMutation,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight } from "@untitledui/icons";
import { createContext, Suspense, useContext, useRef, useState } from "react";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import { CompanionMcpsSectionSkeleton } from "./reports-onboarding/companion-mcps-section.tsx";
import {
  buildScheduleMeetingUrl,
  ScheduleMeetingVisual,
} from "./reports-onboarding/schedule-meeting.tsx";
import { SiteBadge } from "./reports-onboarding/site-badge.tsx";
import { ReportsOnboardingLoadingIndicator } from "./reports-onboarding/loading-state.tsx";
import { parseSelfToolResult } from "./reports-onboarding/self-tool-result.ts";
import { translateSiteError } from "./reports-onboarding/site-error.ts";
import { cn } from "@decocms/ui/lib/utils.ts";

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

export default function CommerceOnboardingRoute() {
  return <CommerceOnboardingPage />;
}

/**
 * Hostname derived from the `siteUrl` query param (e.g. "fila.com.br"),
 * provided to the whole onboarding experience so every header renders the
 * deco + site badge. `null` when no valid `siteUrl` is present.
 */
const ReportsSiteHostContext = createContext<string | null>(null);

const useReportsSiteHost = () => useContext(ReportsSiteHostContext);

type CommerceOnboardingLayoutProps = ComponentProps<typeof AuthSplitLayout>;

function LanguageSwitcher() {
  const [preferences, setPreferences] = usePreferences();
  const currentLang = preferences.language === "pt-BR" ? "PT-BR" : "EN";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors"
          type="button"
        >
          {currentLang}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            setPreferences((prev) => ({
              ...prev,
              language: "en",
            }));
          }}
          className={cn(preferences.language === "en" && "bg-accent")}
        >
          English
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setPreferences((prev) => ({
              ...prev,
              language: "pt-BR",
            }));
          }}
          className={cn(preferences.language === "pt-BR" && "bg-accent")}
        >
          Português (Brasil)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommerceOnboardingLayout({
  visual,
  children,
  ...rest
}: CommerceOnboardingLayoutProps) {
  const search = useSearch({ from: "/reports-onboarding" });
  const { data: session } = authClient.useSession();
  const [preferences] = usePreferences();
  const meetingUrl = buildScheduleMeetingUrl({
    siteUrl: search.siteUrl,
    email: session?.user?.email,
    locale: preferences.language,
  });

  return (
    <AuthSplitLayout
      {...rest}
      visual={visual ?? <ScheduleMeetingVisual href={meetingUrl} />}
    >
      <div className="flex justify-between items-start mb-8">
        <div />
        <LanguageSwitcher />
      </div>
      {children}
    </AuthSplitLayout>
  );
}

function getReportsAuthCopy(t: ReturnType<typeof useT>) {
  return {
    signUpFailed: t("routes.reportsOnboarding.authCopy.signUpFailed"),
    signInFailed: t("routes.reportsOnboarding.authCopy.signInFailed"),
    authenticationFailed: t(
      "routes.reportsOnboarding.authCopy.authenticationFailed",
    ),
    resetEmailFailed: t("routes.reportsOnboarding.authCopy.resetEmailFailed"),
    otpSendFailed: t("routes.reportsOnboarding.authCopy.otpSendFailed"),
    invalidCode: t("routes.reportsOnboarding.authCopy.invalidCode"),
    invalidEmail: t("routes.reportsOnboarding.authCopy.invalidEmail"),
    invalidEmailOrPassword: t(
      "routes.reportsOnboarding.authCopy.invalidEmailOrPassword",
    ),
    accountExists: t("routes.reportsOnboarding.authCopy.accountExists"),
    networkError: t("routes.reportsOnboarding.authCopy.networkError"),
    tooManyAttempts: t("routes.reportsOnboarding.authCopy.tooManyAttempts"),
    invalidOrExpiredCode: t(
      "routes.reportsOnboarding.authCopy.invalidOrExpiredCode",
    ),
    genericError: t("routes.reportsOnboarding.authCopy.genericError"),
    resetPasswordTitle: t(
      "routes.reportsOnboarding.authCopy.resetPasswordTitle",
    ),
    verificationCodeTitle: t(
      "routes.reportsOnboarding.authCopy.verificationCodeTitle",
    ),
    welcomeTitle: t("routes.reportsOnboarding.authCopy.welcomeTitle"),
    resetPasswordSubtitle: t(
      "routes.reportsOnboarding.authCopy.resetPasswordSubtitle",
    ),
    codeSentTo: (email: string) =>
      t("routes.reportsOnboarding.authCopy.codeSentTo", { email }),
    defaultSubtitle: t("routes.reportsOnboarding.authCopy.defaultSubtitle"),
    resetEmailSent: t("routes.reportsOnboarding.authCopy.resetEmailSent"),
    continueWith: (provider: string) =>
      t("routes.reportsOnboarding.authCopy.continueWith", { provider }),
    divider: t("routes.reportsOnboarding.authCopy.divider"),
    emailLabel: t("routes.reportsOnboarding.authCopy.emailLabel"),
    emailPlaceholder: t("routes.reportsOnboarding.authCopy.emailPlaceholder"),
    sending: t("routes.reportsOnboarding.authCopy.sending"),
    sendCode: t("routes.reportsOnboarding.authCopy.sendCode"),
    verificationCodeLabel: t(
      "routes.reportsOnboarding.authCopy.verificationCodeLabel",
    ),
    enterCodePlaceholder: t(
      "routes.reportsOnboarding.authCopy.enterCodePlaceholder",
    ),
    verifying: t("routes.reportsOnboarding.authCopy.verifying"),
    verify: t("routes.reportsOnboarding.authCopy.verify"),
    useDifferentEmail: t("routes.reportsOnboarding.authCopy.useDifferentEmail"),
    sendResetLink: t("routes.reportsOnboarding.authCopy.sendResetLink"),
    nameLabel: t("routes.reportsOnboarding.authCopy.nameLabel"),
    namePlaceholder: t("routes.reportsOnboarding.authCopy.namePlaceholder"),
    passwordLabel: t("routes.reportsOnboarding.authCopy.passwordLabel"),
    forgotPassword: t("routes.reportsOnboarding.authCopy.forgotPassword"),
    creatingAccount: t("routes.reportsOnboarding.authCopy.creatingAccount"),
    signingIn: t("routes.reportsOnboarding.authCopy.signingIn"),
    continue: t("routes.reportsOnboarding.authCopy.continue"),
    backToSignIn: t("routes.reportsOnboarding.authCopy.backToSignIn"),
    signInWithPassword: t(
      "routes.reportsOnboarding.authCopy.signInWithPassword",
    ),
    alreadyHaveAccount: t(
      "routes.reportsOnboarding.authCopy.alreadyHaveAccount",
    ),
    dontHaveAccount: t("routes.reportsOnboarding.authCopy.dontHaveAccount"),
    signIn: t("routes.reportsOnboarding.authCopy.signIn"),
    signUp: t("routes.reportsOnboarding.authCopy.signUp"),
    signInWithEmailCode: t(
      "routes.reportsOnboarding.authCopy.signInWithEmailCode",
    ),
  };
}

// One-shot per SPA load, render-time (useEffect is banned in this app; same
// pattern as PostHogIdentitySync). This is the LP→studio funnel seam: the
// diagnostic deck's CTAs land here, so this event is funnel step "arrived in
// studio", joinable to the LP journey via the bootstrapped ph_did identity.
let onboardingViewTracked = false;

function CommerceOnboardingPage() {
  const search = useSearch({ from: "/reports-onboarding" });
  const { org: requestedOrgSlug, siteUrl } = search;
  const siteHost = siteUrlToHost(siteUrl);

  if (!onboardingViewTracked && isPostHogInitialized()) {
    onboardingViewTracked = true;
    // Joins back to the report deck's connect CTA — see reports/onboarding.ts.
    const reportAttribution = reportAttributionFromSearch(
      window.location.search,
    );
    track("commerce_onboarding_viewed", {
      site_url: siteUrl,
      domain: siteHost ?? undefined,
      ...reportAttribution,
      // Person-level copy so the store follows the user across sessions.
      ...(siteHost ? { $set: { last_scanned_domain: siteHost } } : {}),
    });
  }

  return (
    <ReportsSiteHostContext.Provider value={siteHost}>
      <CommerceOnboardingScreens
        requestedOrgSlug={requestedOrgSlug}
        siteUrl={siteUrl}
      />
    </ReportsSiteHostContext.Provider>
  );
}

function CommerceOnboardingScreens({
  requestedOrgSlug,
  siteUrl,
}: {
  requestedOrgSlug?: string;
  siteUrl?: string;
}) {
  const t = useT();
  const { data: session, isPending: sessionLoading } = authClient.useSession();
  const siteHost = useReportsSiteHost();

  if (sessionLoading) {
    return (
      <CommerceOnboardingLayout>
        <ReportsOnboardingLoadingIndicator variant="generic" />
      </CommerceOnboardingLayout>
    );
  }

  if (!session) {
    const callbackUrl =
      typeof window === "undefined"
        ? "/reports-onboarding"
        : `${window.location.pathname}${window.location.search}`;

    return (
      <CommerceOnboardingLayout>
        <AuthEntry
          callbackUrl={callbackUrl}
          allowAutoLogin={false}
          title={t("routes.reportsOnboarding.unlockDiagnostic")}
          subtitle={null}
          brand={siteHost ? <SiteBadge host={siteHost} /> : undefined}
          copy={getReportsAuthCopy(t)}
        />
      </CommerceOnboardingLayout>
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
  const t = useT();
  const navigate = useNavigate();
  const organizationsQuery = useActiveOrganizations();
  const [selectedOrg, setSelectedOrg] = useState<CommerceOrganization | null>(
    null,
  );
  const [settledEnsureResult, setSettledEnsureResult] =
    useState<EnsureOrganizationResponse | null>(null);
  const [creatingOrg, setCreatingOrg] = useState(false);

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
      <CommerceOnboardingLayout>
        <ReportsOnboardingLoadingIndicator variant="workspace" />
      </CommerceOnboardingLayout>
    );
  }

  if (organizationsQuery.error) {
    return (
      <CommerceErrorState
        title={t("routes.reportsOnboarding.couldNotLoadOrgs")}
        description={t("routes.reportsOnboarding.retryToConfigureCommerce")}
        actionLabel={t("routes.reportsOnboarding.retryAgain")}
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
        title={t("routes.reportsOnboarding.orgNotFound")}
        description={t("routes.reportsOnboarding.couldNotFindOrg")}
        actionLabel={t("routes.reportsOnboarding.retryAgain")}
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
      <CommerceOnboardingLayout>
        <div className="grid gap-10">
          <CommerceHeader
            title={t("routes.reportsOnboarding.chooseOrg")}
            description={t(
              "routes.reportsOnboarding.selectWhereCommerceContinues",
            )}
          />
          <ScrollReveal className="-mx-1 -my-1 max-h-[60vh] overflow-y-auto px-1 py-1">
            <OrganizationChoice
              organizations={activeOrganizations}
              selectLabel={t("routes.reportsOnboarding.authCopy.continue")}
              onSelected={(organization) =>
                // Persisted in the URL (not local state) so a refresh doesn't
                // lose the pick and force reselecting among active orgs.
                navigate({
                  to: "/reports-onboarding",
                  search: { org: organization.slug, siteUrl },
                })
              }
              onCreateNew={() => setCreatingOrg(true)}
              createNewLabel={t("routes.reportsOnboarding.createNewOrg")}
            />
          </ScrollReveal>
        </div>
        <CreateOrganizationDialog
          open={creatingOrg}
          onOpenChange={setCreatingOrg}
          onCreated={(orgSlug) => {
            invalidateOrganizationListCache();
            navigate({
              to: "/reports-onboarding",
              search: { org: orgSlug, siteUrl },
            });
          }}
        />
      </CommerceOnboardingLayout>
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
      <CommerceOnboardingLayout>
        <div className="grid gap-10">
          <CommerceHeader
            title={t("routes.reportsOnboarding.chooseOrg")}
            description={t("routes.reportsOnboarding.emailAccessMultipleOrgs")}
          />
          <ScrollReveal className="-mx-1 -my-1 max-h-[60vh] overflow-y-auto px-1 py-1">
            <OrganizationChoice
              organizations={ensureResult.organizations}
              domain={ensureResult.domain ?? undefined}
              onJoined={(organization, slug) => {
                invalidateOrganizationListCache();
                setSelectedOrg({ ...organization, slug });
                navigate({
                  to: "/reports-onboarding",
                  search: { org: slug, siteUrl },
                });
              }}
              onCreateNew={() => setCreatingOrg(true)}
              createNewLabel={t("routes.reportsOnboarding.createNewOrg")}
            />
          </ScrollReveal>
        </div>
        <CreateOrganizationDialog
          open={creatingOrg}
          onOpenChange={setCreatingOrg}
          onCreated={(orgSlug) => {
            invalidateOrganizationListCache();
            navigate({
              to: "/reports-onboarding",
              search: { org: orgSlug, siteUrl },
            });
          }}
        />
      </CommerceOnboardingLayout>
    );
  }

  return (
    <CommerceErrorState
      title={t("routes.reportsOnboarding.onboardingNeedsSupport")}
      description={
        ensureResult?.error ??
        t("routes.reportsOnboarding.couldNotDetermineOrg")
      }
      actionLabel={t("routes.reportsOnboarding.retryAgain")}
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
  const t = useT();
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
        title={t("routes.reportsOnboarding.onboardingUnavailable")}
        description={t("routes.reportsOnboarding.couldNotPrepareOrg")}
        actionLabel={t("routes.reportsOnboarding.retryAgain")}
        onRetry={onRetry}
      />
    );
  }

  return (
    <CommerceOnboardingLayout>
      <div ref={triggerRecovery}>
        <ReportsOnboardingLoadingIndicator variant="generic" />
      </div>
    </CommerceOnboardingLayout>
  );
}

function CommerceHeader({
  title,
  description,
}: {
  title?: string;
  description?: string;
}) {
  const siteHost = useReportsSiteHost();
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
    <CommerceOnboardingLayout>
      <div className="grid gap-10">
        <CommerceHeader title={title} description={description} />
        <Button type="button" size="xl" className="w-full" onClick={onRetry}>
          {actionLabel}
        </Button>
      </div>
    </CommerceOnboardingLayout>
  );
}

function CommerceSetup({
  org,
  initialSiteUrl,
}: {
  org: CommerceOrganization;
  initialSiteUrl?: string;
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const [preferences] = usePreferences();
  const meetingUrl = buildScheduleMeetingUrl({
    siteUrl: initialSiteUrl,
    email: session?.user?.email,
    locale: preferences.language,
  });
  const meetingVisual = (
    <ScheduleMeetingVisual href={meetingUrl} orgId={org.id} />
  );

  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          fallback={({ error, resetError }) => (
            <CommerceOnboardingLayout visual={meetingVisual}>
              {/* TODO(i18n): error message passed to CommerceSetupErrorState may be either dynamic or translated */}
              <CommerceSetupErrorState
                orgName={org.name}
                message={
                  error instanceof Error
                    ? error.message
                    : t(
                        "routes.reportsOnboarding.couldNotVerifyCommerceSetting",
                      )
                }
                onRetry={() => {
                  reset();
                  resetError();
                }}
              />
            </CommerceOnboardingLayout>
          )}
        >
          <Suspense
            fallback={<CommerceDiagnosticLoading visual={meetingVisual} />}
          >
            <CommerceSetupContent
              key={`${org.id}:${initialSiteUrl ?? ""}`}
              org={org}
              initialSiteUrl={initialSiteUrl}
              sessionEmail={session?.user?.email}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function CommerceDiagnosticLoading({ visual }: { visual?: ReactNode }) {
  return (
    <CommerceOnboardingLayout align="fill" visual={visual}>
      <div className="flex min-h-0 flex-1 flex-col gap-6 md:grid md:gap-4">
        <CommerceHeader />
        <CompanionMcpsSectionSkeleton />
      </div>
    </CommerceOnboardingLayout>
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
  const t = useT();
  return (
    <div className="grid gap-10">
      <CommerceHeader
        title={t("routes.reportsOnboarding.commerceDiagnostic")}
        description={t("routes.reportsOnboarding.configurationWillContinueIn", {
          orgName,
        })}
      />
      <InlineError message={message} />
      <Button type="button" size="xl" className="w-full" onClick={onRetry}>
        {t("routes.reportsOnboarding.retryAgain")}
      </Button>
    </div>
  );
}

function CommerceSetupContent({
  org,
  initialSiteUrl,
  sessionEmail,
}: {
  org: CommerceOrganization;
  initialSiteUrl?: string;
  sessionEmail?: string | null;
}) {
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [siteUrlInput, setSiteUrlInput] = useState(initialSiteUrl ?? "");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const autoSetupStartedRef = useRef(false);

  const connectionId = WellKnownOrgMCPId.REPORTS(org.id);
  const virtualMcpId = getReportsAgentId(org.id);

  const connectionQuery = useSuspenseQuery({
    queryKey: KEYS.reportsConnection(org.id, connectionId),
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
    queryKey: KEYS.reportsVirtualMcp(org.id, virtualMcpId),
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
        name: "REPORTS_SETUP",
        arguments: { siteUrl },
      });
      return parseSelfToolResult<unknown>(result);
    },
    retry: false,
    onSuccess: (_result, submittedSiteUrl) => {
      track("commerce_onboarding_setup_succeeded", {
        domain: siteUrlToHost(submittedSiteUrl) ?? undefined,
        organization_id: org.id,
      });
      setInlineError(null);
      void connectionQuery.refetch();
      void virtualMcpQuery.refetch();
    },
    onError: (error, submittedSiteUrl) => {
      track("commerce_onboarding_setup_failed", {
        domain: siteUrlToHost(submittedSiteUrl) ?? undefined,
        organization_id: org.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Dynamic server errors pass through; the static fallback uses a sentinel
      // translated at render time so it respects language switches.
      setInlineError(
        error instanceof Error ? error.message : "__configurationFailed",
      );
    },
  });

  const connectionExists =
    !!connectionQuery.data.item && !!virtualMcpQuery.data.item;
  // A returning session may arrive with no ?siteUrl param and an empty form while
  // the connection already exists. Recover the site from the connection metadata
  // (persisted at setup) so the run can still be triggered.
  const connectionItem = connectionQuery.data.item as unknown as
    | { metadata?: Record<string, unknown> | null }
    | null
    | undefined;
  const connectionSiteUrl =
    typeof connectionItem?.metadata?.siteUrl === "string"
      ? (connectionItem.metadata.siteUrl as string)
      : undefined;
  // The CD connection is per-ORG, but its token is claimed per-SITE (setup calls
  // /upgrade, which mints a token scoped to one site and persists it here). So an
  // org that already has a connection for site A, then opens the onboarding for
  // site B, must RE-RUN setup to re-claim B — otherwise the report renders A's
  // diagnostic (the wrong store) and REPORTS_RUN(B) returns
  // not_upgraded. Treat the connection as ready ONLY when it's claimed for the
  // requested site; when the site differs, fall through to setup (idempotent
  // re-claim) so the token + metadata.siteUrl follow the site being onboarded.
  const requestedSite = initialSiteUrl || siteUrlInput || "";
  const claimedForRequestedSite = isConnectionClaimedForSite(
    requestedSite,
    connectionSiteUrl,
  );
  const setupReady = connectionExists && claimedForRequestedSite;
  const currentSiteUrl =
    initialSiteUrl || siteUrlInput || connectionSiteUrl || "";
  const t = useT();
  const [preferences] = usePreferences();

  const currentMeetingUrl = buildScheduleMeetingUrl({
    siteUrl: currentSiteUrl,
    email: sessionEmail,
    locale: preferences.language,
  });
  const currentMeetingVisual = (
    <ScheduleMeetingVisual href={currentMeetingUrl} orgId={org.id} />
  );

  const translatedError = inlineError
    ? translateSiteError(t, inlineError)
    : null;

  const runSetup = (rawSiteUrl: string) => {
    const normalized = normalizeReportsSiteUrl(rawSiteUrl);
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
    const normalizedForTracking = normalizeReportsSiteUrl(siteUrlInput);
    if (normalizedForTracking.ok) {
      track("commerce_onboarding_site_url_submitted", {
        domain: new URL(normalizedForTracking.value).hostname,
        organization_id: org.id,
      });
    }
    runSetup(siteUrlInput);
  };

  // Site is claimed → hand off to the org. The blocking connections modal
  // (mounted by the org shell when it sees `?connect=1`) takes over from here:
  // the user connects at least one data source over the blurred ORG HOME, then
  // the modal triggers the run and opens the report. We land on the Super Agent
  // home thread (not `/$org`, which reports-only orgs bounce back here) so the
  // modal sits over real org content instead of a blank report.
  if (setupReady) {
    return (
      <Navigate
        to="/$org/home"
        params={{ org: org.slug }}
        search={{
          connect: "1",
          siteUrl: currentSiteUrl || undefined,
        }}
        replace
      />
    );
  }

  if (setupMutation.isPending) {
    return <CommerceDiagnosticLoading visual={currentMeetingVisual} />;
  }

  if (initialSiteUrl) {
    const normalized = normalizeReportsSiteUrl(initialSiteUrl);

    if (!normalized.ok) {
      return (
        <CommerceOnboardingLayout visual={currentMeetingVisual}>
          <div className="grid gap-10">
            <CommerceHeader
              title={t("routes.reportsOnboarding.commerceDiagnostic")}
              description={t(
                "routes.reportsOnboarding.configurationWillContinueIn",
                { orgName: org.name },
              )}
            />
            <InlineError message={translateSiteError(t, normalized.error)} />
            <SiteUrlForm
              siteUrl={siteUrlInput}
              error={translatedError}
              isSubmitting={setupMutation.isPending}
              onSiteUrlChange={setSiteUrlInput}
              onSubmit={handleSubmit}
            />
          </div>
        </CommerceOnboardingLayout>
      );
    }

    return (
      <CommerceOnboardingLayout visual={currentMeetingVisual}>
        <div ref={triggerInitialSetup} className="grid gap-10">
          <CommerceHeader
            title={t("routes.reportsOnboarding.commerceDiagnostic")}
            description={t("routes.reportsOnboarding.reportsBeingPrepared", {
              url: normalized.value,
            })}
          />
          {translatedError ? (
            <>
              <InlineError message={translatedError} />
              <SiteUrlForm
                siteUrl={siteUrlInput}
                error={null}
                isSubmitting={setupMutation.isPending}
                onSiteUrlChange={setSiteUrlInput}
                onSubmit={handleSubmit}
              />
            </>
          ) : (
            <CompanionMcpsSectionSkeleton />
          )}
        </div>
      </CommerceOnboardingLayout>
    );
  }

  return (
    <CommerceOnboardingLayout visual={currentMeetingVisual}>
      <div className="grid gap-10">
        <CommerceHeader
          title={t("routes.reportsOnboarding.commerceDiagnostic")}
          description={t(
            "routes.reportsOnboarding.configurationWillContinueIn",
            { orgName: org.name },
          )}
        />
        <SiteUrlForm
          siteUrl={siteUrlInput}
          error={translatedError}
          isSubmitting={setupMutation.isPending}
          onSiteUrlChange={setSiteUrlInput}
          onSubmit={handleSubmit}
        />
      </div>
    </CommerceOnboardingLayout>
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
  const t = useT();
  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="commerce-site-url">
          {t("routes.reportsOnboarding.siteUrlLabel")}
        </label>
        <Input
          id="commerce-site-url"
          type="text"
          inputMode="url"
          value={siteUrl}
          onChange={(event) => onSiteUrlChange(event.target.value)}
          placeholder={t("routes.reportsOnboarding.siteUrlPlaceholder")}
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
        {t("routes.reportsOnboarding.authCopy.continue")}
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="text-sm leading-5 text-destructive" role="alert">
      {message}
    </p>
  );
}
