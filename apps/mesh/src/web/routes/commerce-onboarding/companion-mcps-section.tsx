import { ScrollReveal } from "@/web/components/scroll-reveal";
import { authClient } from "@/web/lib/auth-client";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowRight } from "@untitledui/icons";
import { useCommerceSiteHost } from "../commerce-onboarding.tsx";
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
  reportDisabled,
  onOpenReport,
}: {
  org: CompanionOrg;
  cdConnectionId: string;
  reportDisabled: boolean;
  onOpenReport: () => void;
}) {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const siteHost = useCommerceSiteHost();
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

  const cta = (
    <Button
      type="button"
      size="xl"
      className="w-full"
      onClick={onOpenReport}
      disabled={reportDisabled}
    >
      See full report
      <ArrowRight size={16} />
    </Button>
  );

  // Empty: no requirements survive → just the report CTA (section header hidden).
  if (!isLoading && !error && cards.length === 0) {
    // On mobile the parent gives us a full-height flex column, so pin the CTA to
    // the bottom; on md+ fall back to the natural grid.
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-10 md:grid md:flex-none">
        {cta}
      </div>
    );
  }

  const busy = connectingFieldKey !== null;

  return (
    // On mobile this grows to fill the parent's full-height column (header pinned
    // top, CTA pinned bottom, cards scroll in between); on md+ it's the compact grid.
    <div className="flex min-h-0 flex-1 flex-col gap-6 md:grid md:flex-none">
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
        <div className="flex min-h-0 flex-1 flex-col gap-4">
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
                onConnect={() => void connect(card)}
                orgId={org.id}
                orgSlug={org.slug}
                siteHost={siteHost}
              />
            ))}
          </div>
        </ScrollReveal>
      )}

      {cta}
    </div>
  );
}
