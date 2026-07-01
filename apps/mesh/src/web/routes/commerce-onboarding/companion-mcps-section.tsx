import { ScrollReveal } from "@/web/components/scroll-reveal";
import { authClient } from "@/web/lib/auth-client";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { CompanionCard, CompanionCardSkeleton } from "./companion-card.tsx";
import { useCommerceCompanions } from "./use-commerce-companions.ts";
import { useConnectCompanion } from "./use-connect-companion.ts";

interface CompanionOrg {
  id: string;
  slug: string;
}

export function CompanionMcpsSection({
  org,
  cdConnectionId,
}: {
  org: CompanionOrg;
  cdConnectionId: string;
}) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { cards, isLoading, error } = useCommerceCompanions({
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

  // Empty: nothing to connect → render nothing (the parent footer still shows
  // the report CTA).
  if (!isLoading && !error && cards.length === 0) {
    return null;
  }

  const busy = connectingFieldKey !== null;

  return (
    // Mobile: fill the parent's remaining height — the header + intro copy stay
    // pinned while the card list scrolls. md+: natural block with a capped
    // scroll area so the right panel stays visible.
    <div className="flex min-h-0 flex-1 flex-col gap-6 md:block md:flex-none">
      <div className="grid gap-1.5">
        <p className="text-2xl font-medium text-foreground">
          Unlock your full diagnostic
        </p>
        <p className="text-base text-muted-foreground">
          Connect your tools to unlock 100+ checks across your funnel.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-2xl border border-border bg-card p-4"
        >
          <p className="text-sm text-foreground">
            Couldn't load companion integrations.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Reload the page to try again.
          </p>
        </div>
      ) : isLoading ? (
        <div className="grid gap-4">
          {[0, 1, 2].map((i) => (
            <CompanionCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <ScrollReveal
          wrapperClassName="flex min-h-0 flex-1 flex-col md:block"
          className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 md:max-h-[45vh] md:flex-none"
        >
          <div className="grid gap-4">
            {connectError && (
              <p role="alert" className="text-sm text-destructive">
                {connectError}
              </p>
            )}
            {cards.map((card) => (
              <CompanionCard
                key={card.fieldKey}
                card={card}
                connecting={connectingFieldKey === card.fieldKey}
                disabled={busy && connectingFieldKey !== card.fieldKey}
                org={org}
                selfClient={selfClient}
                onConnect={() => void connect(card)}
              />
            ))}
          </div>
        </ScrollReveal>
      )}
    </div>
  );
}
