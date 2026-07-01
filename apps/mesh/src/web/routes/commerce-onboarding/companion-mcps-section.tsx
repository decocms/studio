import { ScrollReveal } from "@/web/components/scroll-reveal";
import { authClient } from "@/web/lib/auth-client";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowRight } from "@untitledui/icons";
import { CompanionCard } from "./companion-card.tsx";
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
    return <div className="grid gap-10">{cta}</div>;
  }

  const busy = connectingFieldKey !== null;

  return (
    <div className="grid gap-6">
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
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-border bg-muted/40"
            />
          ))}
        </div>
      ) : (
        <ScrollReveal className="-mx-1 max-h-[45vh] overflow-y-auto px-1">
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
              />
            ))}
          </div>
        </ScrollReveal>
      )}

      {cta}
    </div>
  );
}
