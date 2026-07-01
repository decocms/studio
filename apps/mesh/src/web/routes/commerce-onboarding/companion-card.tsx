import { IntegrationIcon } from "@/web/components/integration-icon";
import { Button } from "@deco/ui/components/button.tsx";
import { CheckCircle, Loading01 } from "@untitledui/icons";
import type { CompanionCardModel } from "./companions-core.ts";

function UnlockLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 p-1">
      <CheckCircle size={14} className="shrink-0 text-muted-foreground" />
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
        <IntegrationIcon icon={card.icon} name={card.title} size="md" />
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
