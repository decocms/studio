import {
  isConnectionClaimedForSite,
  normalizeReportsSiteUrl,
} from "@/reports/site-url";
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
import { isPostHogInitialized, track } from "@/web/lib/posthog-client";
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
import { ArrowRight } from "@untitledui/icons";
import { createContext, Suspense, useContext, useRef, useState } from "react";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import {
  CompanionMcpsSection,
  CompanionMcpsSectionSkeleton,
} from "./commerce-onboarding/companion-mcps-section.tsx";
import {
  buildScheduleMeetingUrl,
  ScheduleMeetingBanner,
  ScheduleMeetingVisual,
} from "./commerce-onboarding/schedule-meeting.tsx";
import { SiteBadge } from "./commerce-onboarding/site-badge.tsx";
import { CommerceOnboardingLoadingIndicator } from "./commerce-onboarding/loading-state.tsx";

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

type CommerceOnboardingLayoutProps = ComponentProps<typeof AuthSplitLayout>;

function CommerceOnboardingLayout({
  visual,
  ...props
}: CommerceOnboardingLayoutProps) {
  const search = useSearch({ from: "/commerce-onboarding" });
  const { data: session } = authClient.useSession();
  const meetingUrl = buildScheduleMeetingUrl({
    siteUrl: search.siteUrl,
    email: session?.user?.email,
  });

  return (
    <AuthSplitLayout
      {...props}
      visual={visual ?? <ScheduleMeetingVisual href={meetingUrl} />}
    />
  );
}

const COMMERCE_AUTH_COPY = {
  signUpFailed: "Falha ao criar conta",
  signInFailed: "Falha ao entrar",
  authenticationFailed: "Falha na autenticação",
  resetEmailFailed: "Não foi possível enviar o e-mail de redefinição",
  otpSendFailed: "Não foi possível enviar o código",
  invalidCode: "Código inválido",
  invalidEmail: "E-mail inválido",
  invalidEmailOrPassword: "E-mail ou senha inválidos. Tente novamente.",
  accountExists:
    "Já existe uma conta com este e-mail. Tente entrar em vez de criar uma nova conta.",
  networkError: "Erro de rede. Verifique sua conexão e tente novamente.",
  tooManyAttempts: "Muitas tentativas. Aguarde um momento e tente novamente.",
  invalidOrExpiredCode: "Código inválido ou expirado. Tente novamente.",
  genericError: "Algo deu errado. Tente novamente.",
  resetPasswordTitle: "Redefinir sua senha",
  verificationCodeTitle: "Informe o código de verificação",
  welcomeTitle: "Bem-vindo à deco",
  resetPasswordSubtitle: "Enviaremos um link de redefinição",
  codeSentTo: (email: string) => `Código enviado para ${email}`,
  defaultSubtitle: "Entre ou crie uma nova conta",
  resetEmailSent: "Verifique seu e-mail para redefinir a senha.",
  continueWith: (provider: string) => `Continuar com ${provider}`,
  divider: "ou",
  emailLabel: "E-mail",
  emailPlaceholder: "Endereço de e-mail",
  sending: "Enviando...",
  sendCode: "Enviar código",
  verificationCodeLabel: "Código de verificação",
  enterCodePlaceholder: "Informe o código",
  verifying: "Verificando...",
  verify: "Verificar",
  useDifferentEmail: "Usar outro e-mail",
  sendResetLink: "Enviar link de redefinição",
  nameLabel: "Nome",
  namePlaceholder: "Seu nome",
  passwordLabel: "Senha",
  forgotPassword: "Esqueceu a senha?",
  creatingAccount: "Criando conta...",
  signingIn: "Entrando...",
  continue: "Continuar",
  backToSignIn: "Voltar para entrar",
  signInWithPassword: "Entrar com senha",
  alreadyHaveAccount: "Já tem uma conta? ",
  dontHaveAccount: "Não tem uma conta? ",
  signIn: "Entrar",
  signUp: "Criar conta",
  signInWithEmailCode: "Entrar com código por e-mail",
};

function siteUrlToHost(siteUrl?: string): string | null {
  if (!siteUrl) return null;
  const normalized = normalizeReportsSiteUrl(siteUrl);
  return normalized.ok ? new URL(normalized.value).hostname : null;
}

function commerceSiteUrlErrorPtBr(error: string): string {
  switch (error) {
    case "Enter a website URL.":
      return "Informe a URL de um site.";
    case "Use an HTTP or HTTPS website URL.":
      return "Use uma URL de site HTTP ou HTTPS.";
    case "Enter a valid website URL.":
      return "Informe uma URL de site válida.";
    default:
      return error;
  }
}

// One-shot per SPA load, render-time (useEffect is banned in this app; same
// pattern as PostHogIdentitySync). This is the LP→studio funnel seam: the
// diagnostic deck's CTAs land here, so this event is funnel step "arrived in
// studio", joinable to the LP journey via the bootstrapped ph_did identity.
let onboardingViewTracked = false;

function CommerceOnboardingPage() {
  const search = useSearch({ from: "/commerce-onboarding" });
  const { org: requestedOrgSlug, siteUrl } = search;
  const siteHost = siteUrlToHost(siteUrl);

  if (!onboardingViewTracked && isPostHogInitialized()) {
    onboardingViewTracked = true;
    track("commerce_onboarding_viewed", {
      site_url: siteUrl,
      domain: siteHost ?? undefined,
      // Person-level copy so the store follows the user across sessions.
      ...(siteHost ? { $set: { last_scanned_domain: siteHost } } : {}),
    });
  }

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
      <CommerceOnboardingLayout>
        <CommerceOnboardingLoadingIndicator variant="generic" />
      </CommerceOnboardingLayout>
    );
  }

  if (!session) {
    const callbackUrl =
      typeof window === "undefined"
        ? "/commerce-onboarding"
        : `${window.location.pathname}${window.location.search}`;

    return (
      <CommerceOnboardingLayout>
        <AuthEntry
          callbackUrl={callbackUrl}
          allowAutoLogin={false}
          title="Desbloqueie seu diagnóstico completo"
          subtitle={null}
          brand={siteHost ? <SiteBadge host={siteHost} /> : undefined}
          copy={COMMERCE_AUTH_COPY}
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
      <CommerceOnboardingLayout>
        <CommerceOnboardingLoadingIndicator variant="workspace" />
      </CommerceOnboardingLayout>
    );
  }

  if (organizationsQuery.error) {
    return (
      <CommerceErrorState
        title="Não foi possível carregar suas organizações"
        description="Tente novamente para continuar a configuração de commerce nesta página."
        actionLabel="Tentar novamente"
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
        title="Organização não encontrada"
        description="Não conseguimos encontrar essa organização na sua conta."
        actionLabel="Tentar novamente"
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
            title="Escolha uma organização"
            description="Selecione onde o diagnóstico de commerce deve continuar."
          />
          <ScrollReveal className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
            <OrganizationChoice
              organizations={activeOrganizations}
              selectLabel="Continuar"
              onSelected={(organization) =>
                // Persisted in the URL (not local state) so a refresh doesn't
                // lose the pick and force reselecting among active orgs.
                navigate({
                  to: "/commerce-onboarding",
                  search: { org: organization.slug, siteUrl },
                })
              }
            />
          </ScrollReveal>
        </div>
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
            title="Escolha uma organização"
            description="Seu e-mail pode acessar mais de uma organização. Escolha onde a configuração de commerce deve continuar."
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
      </CommerceOnboardingLayout>
    );
  }

  return (
    <CommerceErrorState
      title="O onboarding de commerce precisa de suporte"
      description={
        ensureResult?.error ??
        "Não conseguimos determinar uma organização de commerce para esta conta."
      }
      actionLabel="Tentar novamente"
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
        title="Onboarding de commerce indisponível"
        description="Não foi possível preparar uma organização para a configuração de commerce. Tente novamente por esta página ou fale com o suporte."
        actionLabel="Tentar novamente"
        onRetry={onRetry}
      />
    );
  }

  return (
    <CommerceOnboardingLayout>
      <div ref={triggerRecovery}>
        <CommerceOnboardingLoadingIndicator variant="generic" />
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

function getToolErrorMessage(result: SelfToolResult): string {
  return (
    result.content?.find((item) => item.text)?.text ??
    "A configuração do Commerce Discovery falhou."
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
  const { data: session } = authClient.useSession();
  const meetingUrl = buildScheduleMeetingUrl({
    siteUrl: initialSiteUrl,
    email: session?.user?.email,
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
              <CommerceSetupErrorState
                orgName={org.name}
                message={
                  error instanceof Error
                    ? error.message
                    : "Não foi possível verificar a configuração do Commerce Discovery."
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
  return (
    <div className="grid gap-10">
      <CommerceHeader
        title="Diagnóstico de commerce"
        description={`A configuração de commerce continuará em ${orgName}.`}
      />
      <InlineError message={message} />
      <Button type="button" size="xl" className="w-full" onClick={onRetry}>
        Tentar novamente
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
    onSuccess: (result, submittedSiteUrl) => {
      track("commerce_onboarding_setup_succeeded", {
        domain: siteUrlToHost(submittedSiteUrl) ?? undefined,
        organization_id: org.id,
      });
      setSetupResult(result);
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
      setInlineError(
        error instanceof Error
          ? error.message
          : "A configuração do Commerce Discovery falhou.",
      );
    },
  });

  // Triggers the diagnostic run now that the user has connected their data
  // sources ("See full report"). We await the TRIGGER so a failure surfaces (a
  // generic error, no navigation) instead of silently opening an empty report;
  // the run itself is async — the report view polls for the enriched deck.
  const runMutation = useMutation({
    mutationFn: async (siteUrl: string) => {
      const result = await selfClient.callTool({
        name: "COMMERCE_DISCOVERY_RUN",
        arguments: { siteUrl },
      });
      return parseSelfToolResult<{ triggered: boolean; reason?: string }>(
        result,
      );
    },
    retry: false,
  });
  const [runError, setRunError] = useState<string | null>(null);

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
  // diagnostic (the wrong store) and COMMERCE_DISCOVERY_RUN(B) returns
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
  const currentMeetingUrl = buildScheduleMeetingUrl({
    siteUrl: currentSiteUrl,
    email: sessionEmail,
  });
  const currentMeetingVisual = (
    <ScheduleMeetingVisual href={currentMeetingUrl} orgId={org.id} />
  );

  const runSetup = (rawSiteUrl: string) => {
    const normalized = normalizeReportsSiteUrl(rawSiteUrl);
    if (!normalized.ok) {
      setInlineError(commerceSiteUrlErrorPtBr(normalized.error));
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

  const reportApp = setupResult?.reportApp ?? {
    connectionId,
    virtualMcpId,
    toolName: COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
  };

  const openReport = async () => {
    setRunError(null);
    // The onboarding-completion intent: the click, not the report render
    // (mcp_app_opened covers the render after navigation).
    track("commerce_onboarding_open_report_clicked", {
      domain: siteUrlToHost(currentSiteUrl) ?? undefined,
      organization_id: org.id,
    });
    // Trigger the enriching run now that the user is done connecting. Await it so a
    // failure surfaces (generic message, stay put) instead of silently opening an
    // empty report. No resolvable site (legacy session) ⇒ nothing to trigger, just open.
    const normalized = normalizeReportsSiteUrl(currentSiteUrl);
    if (normalized.ok) {
      try {
        let runResult = await runMutation.mutateAsync(normalized.value);
        // triggered:false means the site isn't claimed for this org on the
        // Commerce Discovery side (not_upgraded — see triggerCommerceDiscoveryRun).
        // This can diverge from the studio connection's metadata.siteUrl (which
        // gates setupReady): the connection looks claimed here, so setup is
        // skipped on load, the report token is never refreshed, and every run
        // 409s — a dead end where "reload" changes nothing. Reconcile by
        // re-running setup (idempotent /upgrade re-claims the site AND persists a
        // fresh connection token, which also fixes the CD proxy 401s), then retry
        // the run once before giving up.
        if (!runResult.triggered) {
          track("commerce_onboarding_run_reclaim", {
            domain: siteUrlToHost(currentSiteUrl) ?? undefined,
            organization_id: org.id,
            reason: runResult.reason ?? "not_upgraded",
          });
          await setupMutation.mutateAsync(normalized.value);
          runResult = await runMutation.mutateAsync(normalized.value);
        }
        // Still not claimed after re-upgrading (e.g. the site belongs to another
        // org). Opening the report anyway would render whatever the connection's
        // token still points at (a previously-claimed site's diagnostic), so
        // surface the error and stay put instead of showing the wrong store.
        if (!runResult.triggered) {
          track("commerce_onboarding_run_failed", {
            domain: siteUrlToHost(currentSiteUrl) ?? undefined,
            organization_id: org.id,
            error: runResult.reason ?? "not_triggered",
          });
          setRunError(
            "Não foi possível gerar o relatório para este site. Recarregue a página e tente novamente.",
          );
          return;
        }
      } catch (err) {
        track("commerce_onboarding_run_failed", {
          domain: siteUrlToHost(currentSiteUrl) ?? undefined,
          organization_id: org.id,
          error: err instanceof Error ? err.message : String(err),
        });
        setRunError(
          "Algo deu errado ao gerar seu relatório. Tente novamente em instantes.",
        );
        return;
      }
    }
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
      },
    });
  };

  if (setupReady) {
    return (
      <CommerceDiscoveryReady
        org={org}
        reportApp={reportApp}
        onOpenReport={openReport}
        isSubmitting={runMutation.isPending}
        error={runError}
        meetingUrl={currentMeetingUrl}
        meetingVisual={currentMeetingVisual}
        siteUrl={currentSiteUrl}
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
              title="Diagnóstico de commerce"
              description={`A configuração de commerce continuará em ${org.name}.`}
            />
            <InlineError message={commerceSiteUrlErrorPtBr(normalized.error)} />
            <SiteUrlForm
              siteUrl={siteUrlInput}
              error={inlineError}
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
            title="Diagnóstico de commerce"
            description={`O Commerce Discovery está sendo preparado para ${normalized.value}.`}
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
          title="Diagnóstico de commerce"
          description={`A configuração de commerce continuará em ${org.name}.`}
        />
        <SiteUrlForm
          siteUrl={siteUrlInput}
          error={inlineError}
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
  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="commerce-site-url">
          URL do site
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
        Continuar
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}

function CommerceDiscoveryReady({
  org,
  reportApp,
  onOpenReport,
  isSubmitting,
  error,
  meetingUrl,
  meetingVisual,
  siteUrl,
}: {
  org: CommerceOrganization;
  reportApp: CommerceDiscoveryReportApp;
  onOpenReport: () => void;
  isSubmitting?: boolean;
  error?: string | null;
  meetingUrl: string;
  meetingVisual: ReactNode;
  siteUrl?: string;
}) {
  // Fails open: stays true (and the CTA usable) unless the companions section
  // positively confirms there are required sources still unconnected. A
  // section load error shouldn't be able to permanently trap the user behind
  // a disabled button — see onReadinessChange below.
  const [hasConnectedSource, setHasConnectedSource] = useState(true);

  return (
    <CommerceOnboardingLayout align="fill" visual={meetingVisual}>
      {/* align="fill" hands us a flex column sized to the visible viewport, so we
          just flex-1 into it — header pinned top, cards scroll in the middle, and
          the footer (report CTA + talk-to-a-human banner) pinned to the bottom.
          On md+ it collapses back to a natural block (right panel has the card). */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 md:grid md:gap-4">
        <CommerceHeader />
        <CompanionMcpsSection
          org={org}
          cdConnectionId={reportApp.connectionId}
          siteUrl={siteUrl}
          onReadinessChange={setHasConnectedSource}
        />
        <div className="flex shrink-0 flex-col gap-3 md:mt-8">
          {/* Right-side ScheduleMeetingVisual is hidden on mobile, so the human
              escape hatch rides in the footer above the report CTA. */}
          <ScheduleMeetingBanner
            className="md:hidden"
            href={meetingUrl}
            orgId={org.id}
          />
          {error ? <InlineError message={error} /> : null}
          <Button
            type="button"
            size="xl"
            className="w-full rounded-2xl text-base font-medium"
            onClick={onOpenReport}
            disabled={
              isSubmitting || !reportApp.virtualMcpId || !hasConnectedSource
            }
          >
            {isSubmitting ? "Abrindo relatório..." : "Ver relatório completo"}
            {!isSubmitting ? <ArrowRight size={18} /> : null}
          </Button>
        </div>
      </div>
    </CommerceOnboardingLayout>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="text-sm leading-5 text-destructive" role="alert">
      {message}
    </p>
  );
}
