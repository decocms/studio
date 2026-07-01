import { IntegrationIcon } from "@/web/components/integration-icon";
import { Button } from "@deco/ui/components/button.tsx";
import { CheckCircle, Loading01 } from "@untitledui/icons";
import type { CompanionCardModel } from "./companions-core.ts";

/**
 * Loading placeholder that mirrors {@link CompanionCard}'s box model (same
 * wrapper, icon row, and two unlock lines) so its height matches a real card
 * instead of a short generic block.
 */
export function CompanionCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted/60" />
        <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
        <div className="ml-auto h-8 w-20 animate-pulse rounded-lg bg-muted/60" />
      </div>
      <div className="flex flex-col gap-1 px-1 py-2">
        <div className="p-1">
          <div className="h-5 w-40 animate-pulse rounded bg-muted/60" />
        </div>
        <div className="p-1">
          <div className="h-5 w-56 animate-pulse rounded bg-muted/60" />
        </div>
      </div>
    </div>
  );
}

function UnlockLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 p-1">
      <CheckCircle size={14} className="shrink-0 text-blue-500" />
      <p className="text-sm text-foreground">{children}</p>
    </div>
  );
}

export function CompanionCard({
  card,
  connecting,
  disabled,
  onConnect,
}: {
  card: CompanionCardModel;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <IntegrationIcon
          icon={card.icon}
          name={card.title}
          size="sm"
          fit="contain"
          className="p-1.5"
        />
        <p className="flex-1 text-sm text-foreground">{card.title}</p>
        {card.satisfied ? (
          <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
            <CheckCircle size={16} /> Connected
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || connecting}
            onClick={onConnect}
            aria-label={`Connect ${card.title}`}
          >
            {connecting ? (
              <Loading01 size={16} className="animate-spin" />
            ) : (
              "Connect"
            )}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1 py-2">
        {card.checks !== null && (
          <UnlockLine>+ {card.checks} checks</UnlockLine>
        )}
        {card.headline && <UnlockLine>{card.headline}</UnlockLine>}
        {card.bullets.map((b) => (
          <UnlockLine key={b}>{b}</UnlockLine>
        ))}
        {!card.satisfied && card.candidateConnectionId && (
          <p className="px-1 text-xs text-muted-foreground">
            Using your existing {card.title}
          </p>
        )}
      </div>
    </div>
  );
}
