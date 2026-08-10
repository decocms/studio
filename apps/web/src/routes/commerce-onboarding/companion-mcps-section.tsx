import { normalizeReportsSiteUrl } from "@decocms/shared/reports/site-url";
import { ErrorBoundary } from "@/components/error-boundary";
import { ScrollReveal } from "@/components/scroll-reveal";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t.ts";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@/sdk";
import { Button } from "@decocms/ui/components/button.tsx";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { CompanionCard, CompanionCardSkeleton } from "./companion-card.tsx";
import { useCommerceCompanions } from "./use-commerce-companions.ts";
import { useConnectCompanion } from "./use-connect-companion.ts";

interface CompanionOrg {
  id: string;
  slug: string;
}

// Shared between the live section, its Suspense fallback, and its error fallback
// so the layout can't drift between the three — see CompanionMcpsSectionSkeleton
// and CompanionMcpsSectionError.
const SECTION_CONTAINER_CLASS =
  "flex min-h-0 flex-1 flex-col gap-6 md:grid md:flex-none md:gap-6";

function SectionIntro() {
  const t = useT();
  // Matches the onboarding title scale (CommerceHeader / auth screen use the
  // same text-2xl font-medium leading-8).
  return (
    <h1 className="text-lg font-medium leading-6 text-foreground lg:text-xl lg:leading-7">
      {t("routes.commerceOnboarding.companionSection.title")}
    </h1>
  );
}

function CompanionCardSkeletons() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1, 2, 3].map((i) => (
        <CompanionCardSkeleton key={i} />
      ))}
    </div>
  );
}

// Suspense fallback for the whole section. `useCommerceCompanions` (and the MCP
// clients it/the cards open) are Suspense queries, so the card loading state now
// lives here as a stable boundary fallback instead of an `isLoading` branch that
// could tear down and re-mount as deeper queries resolve.
export function CompanionMcpsSectionSkeleton() {
  return (
    <div className={SECTION_CONTAINER_CLASS}>
      <SectionIntro />
      <CompanionCardSkeletons />
    </div>
  );
}

function CompanionMcpsSectionError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className={SECTION_CONTAINER_CLASS}>
      <SectionIntro />
      <div
        role="alert"
        className="rounded-2xl border border-border bg-card p-4"
      >
        <p className="text-sm text-foreground">
          {t("routes.commerceOnboarding.companionSection.loadError")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("routes.commerceOnboarding.companionSection.loadErrorDescription")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
        >
          {t("routes.commerceOnboarding.companionSection.retry")}
        </Button>
      </div>
    </div>
  );
}

export function CompanionMcpsSection(props: {
  org: CompanionOrg;
  cdConnectionId: string;
  siteUrl?: string;
  /** Called once cards resolve with whether at least one is connected (or
   *  none are required). Lets the report CTA above this section gate on it. */
  onReadinessChange?: (hasConnectedSource: boolean) => void;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          fallback={({ resetError }) => (
            <CompanionMcpsSectionError
              onRetry={() => {
                reset();
                resetError();
              }}
            />
          )}
        >
          <Suspense fallback={<CompanionMcpsSectionSkeleton />}>
            <CompanionMcpsSectionContent {...props} />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function CompanionMcpsSectionContent({
  org,
  cdConnectionId,
  siteUrl,
  onReadinessChange,
}: {
  org: CompanionOrg;
  cdConnectionId: string;
  siteUrl?: string;
  onReadinessChange?: (hasConnectedSource: boolean) => void;
}) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const normalizedSite = siteUrl ? normalizeReportsSiteUrl(siteUrl) : null;
  let siteHost: string | undefined;
  if (normalizedSite?.ok) {
    try {
      siteHost = new URL(normalizedSite.value).hostname;
    } catch {
      siteHost = undefined;
    }
  }
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { cards, saStatusUnavailable } = useCommerceCompanions({
    selfClient,
    org,
    cdConnectionId,
    siteUrl,
  });
  const {
    connect,
    connectingFieldKey,
    disconnect,
    disconnectingFieldKey,
    error: connectError,
  } = useConnectCompanion({
    selfClient,
    org,
    userId,
    cdConnectionId,
    domain: siteHost,
    siteUrl,
  });
  const [autoOpenConfigFieldKey, setAutoOpenConfigFieldKey] = useState<
    string | null
  >(null);

  // A source counts toward the report only when it's linked AND usable (a VTEX
  // linked with no credentials, or GitHub with no repo, does NOT count).
  const isReady = (c: (typeof cards)[number]) => c.satisfied && c.configured;
  const requiredCards = cards.filter((c) => c.required);
  const enhancedCards = cards.filter((c) => !c.required);

  // Analytics (and any required source) MUST be ready before continuing. When
  // the resolved set has no required source, fall back to "any source ready"
  // so a config that never offers Analytics can't trap the user. Derived during
  // render (not an effect) so the parent's button re-enables the same pass a
  // source becomes ready.
  // When the SA connection status couldn't be read, an existing GA4/GSC binding
  // renders as disconnected — fail open (with the warning below) instead of
  // trapping a user who already connected behind a gate they can't satisfy.
  const ready =
    saStatusUnavailable ||
    (requiredCards.length > 0
      ? requiredCards.every(isReady)
      : cards.length === 0 || cards.some(isReady));
  onReadinessChange?.(ready);

  // Empty: nothing to connect → render nothing (the parent footer still shows
  // the report CTA).
  if (cards.length === 0) {
    return null;
  }

  const busy = connectingFieldKey !== null || disconnectingFieldKey !== null;

  const renderCard = (card: (typeof cards)[number]) => {
    const handleConnect = async () => {
      const connected = await connect(card);
      if (connected) {
        setAutoOpenConfigFieldKey(card.fieldKey);
      }
    };
    return (
      <CompanionCard
        key={card.fieldKey}
        card={card}
        connecting={connectingFieldKey === card.fieldKey}
        disconnecting={disconnectingFieldKey === card.fieldKey}
        disabled={
          busy &&
          connectingFieldKey !== card.fieldKey &&
          disconnectingFieldKey !== card.fieldKey
        }
        org={org}
        selfClient={selfClient}
        siteUrl={siteUrl}
        autoOpenConfigFieldKey={autoOpenConfigFieldKey}
        onAutoOpenConfigHandled={() =>
          setAutoOpenConfigFieldKey((current) =>
            current === card.fieldKey ? null : current,
          )
        }
        onConnect={() => void handleConnect()}
        onDisconnect={() => void disconnect(card)}
      />
    );
  };

  return (
    // Mobile: fill the parent's remaining height — the header + intro copy stay
    // pinned while the card list scrolls. md+: natural block with a capped
    // scroll area so the right panel stays visible.
    <div className={SECTION_CONTAINER_CLASS}>
      <SectionIntro />

      <ScrollReveal
        wrapperClassName="flex min-h-0 flex-1 flex-col md:block"
        // md cap is viewport-aware: ~330px is the column's fixed chrome (header,
        // title, paddings, report CTA), so on short windows the cards scroll
        // internally instead of pushing the CTA below the fold.
        className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 md:max-h-[min(60vh,calc(100dvh-330px))] md:flex-none"
      >
        {connectError && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {connectError}
          </p>
        )}
        {saStatusUnavailable && (
          <p
            role="status"
            className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          >
            {t("routes.commerceOnboarding.companionSection.statusUnavailable")}
          </p>
        )}
        {/* Single list, required source(s) first — the "Obrigatório" pill on the
            card carries the must-vs-optional distinction (no section headers). */}
        <div className="flex flex-col gap-4 pt-3">
          {[...requiredCards, ...enhancedCards].map(renderCard)}
        </div>
      </ScrollReveal>
    </div>
  );
}
