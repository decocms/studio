import { ErrorBoundary } from "@/web/components/error-boundary";
import { ScrollReveal } from "@/web/components/scroll-reveal";
import { authClient } from "@/web/lib/auth-client";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
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
  "flex min-h-0 flex-1 flex-col gap-6 md:grid md:flex-none md:gap-4";

function SectionIntro() {
  return (
    <div className="grid gap-1.5">
      <p className="text-2xl font-medium text-foreground">
        Unlock your full diagnostic
      </p>
      <p className="text-base text-muted-foreground">
        Connect your tools to unlock 100+ checks across your funnel.
      </p>
    </div>
  );
}

function CompanionCardSkeletons() {
  return (
    <div className="grid gap-4">
      {[0, 1, 2].map((i) => (
        <CompanionCardSkeleton key={i} />
      ))}
    </div>
  );
}

// Suspense fallback for the whole section. `useCommerceCompanions` (and the MCP
// clients it/the cards open) are Suspense queries, so the card loading state now
// lives here as a stable boundary fallback instead of an `isLoading` branch that
// could tear down and re-mount as deeper queries resolve.
function CompanionMcpsSectionSkeleton() {
  return (
    <div className={SECTION_CONTAINER_CLASS}>
      <SectionIntro />
      <CompanionCardSkeletons />
    </div>
  );
}

function CompanionMcpsSectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={SECTION_CONTAINER_CLASS}>
      <SectionIntro />
      <div
        role="alert"
        className="rounded-2xl border border-border bg-card p-4"
      >
        <p className="text-sm text-foreground">
          Couldn't load companion integrations.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Something went wrong loading your integrations.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}

export function CompanionMcpsSection(props: {
  org: CompanionOrg;
  cdConnectionId: string;
  siteUrl?: string;
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
}: {
  org: CompanionOrg;
  cdConnectionId: string;
  siteUrl?: string;
}) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { cards } = useCommerceCompanions({
    selfClient,
    org,
    cdConnectionId,
  });
  const {
    connect,
    connectingFieldKey,
    error: connectError,
  } = useConnectCompanion({
    selfClient,
    org,
    userId,
    cdConnectionId,
  });
  const [autoOpenConfigFieldKey, setAutoOpenConfigFieldKey] = useState<
    string | null
  >(null);

  // Empty: nothing to connect → render nothing (the parent footer still shows
  // the report CTA).
  if (cards.length === 0) {
    return null;
  }

  const busy = connectingFieldKey !== null;

  return (
    // Mobile: fill the parent's remaining height — the header + intro copy stay
    // pinned while the card list scrolls. md+: natural block with a capped
    // scroll area so the right panel stays visible.
    <div className={SECTION_CONTAINER_CLASS}>
      <SectionIntro />

      <ScrollReveal
        wrapperClassName="flex min-h-0 flex-1 flex-col md:block"
        className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 md:max-h-[60vh] md:flex-none"
      >
        <div className="grid gap-4">
          {connectError && (
            <p role="alert" className="text-sm text-destructive">
              {connectError}
            </p>
          )}
          {cards.map((card) => {
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
                disabled={busy && connectingFieldKey !== card.fieldKey}
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
              />
            );
          })}
        </div>
      </ScrollReveal>
    </div>
  );
}
