import { useTelosGoal } from "@/web/hooks/use-telos-goal";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  Check,
  LinkExternal01,
  Loading01,
  Target04,
  X,
} from "@untitledui/icons";

const sourceHost = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

export function TelosGoalCard({ orgSlug }: { orgSlug: string }) {
  const { goal, facts, status, confirmFact, rejectFact } =
    useTelosGoal(orgSlug);

  const proposed = facts.filter((f) => f.status === "proposed");
  const confirmed = facts.filter((f) => f.status === "confirmed");

  // Nothing yet and not researching → render nothing.
  if (!goal && facts.length === 0 && status !== "researching") return null;

  if (!goal && facts.length === 0 && status === "researching") {
    return (
      <Card className="w-full flex-row items-center gap-3 p-4">
        <Loading01 className="size-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Researching you to set up your first goal…
        </span>
      </Card>
    );
  }

  return (
    <Card className="w-full flex-col gap-4 p-4">
      {goal && (
        <div className="flex flex-row items-start gap-3">
          <div className="mt-0.5 text-primary">
            <Target04 className="size-5" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Your goal
            </span>
            <span className="text-sm font-medium text-foreground">
              {goal.title}
            </span>
            <span className="text-xs text-muted-foreground">
              Target: {goal.targetValue} {goal.metric.replace(/_/g, " ")}
            </span>
          </div>
        </div>
      )}

      {(proposed.length > 0 || confirmed.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What we found about you
          </span>
          {proposed.map((fact) => (
            <div
              key={fact.id}
              className="flex flex-row items-center justify-between gap-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-foreground">
                  <span className="text-muted-foreground">{fact.label}:</span>{" "}
                  {fact.value}
                </span>
                {sourceHost(fact.sourceUrl) && (
                  <a
                    href={fact.sourceUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <LinkExternal01 className="size-3" />
                    {sourceHost(fact.sourceUrl)}
                  </a>
                )}
              </div>
              <div className="flex shrink-0 flex-row gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Confirm"
                  onClick={() => confirmFact(fact.id)}
                >
                  <Check className="size-4 text-primary" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Reject"
                  onClick={() => rejectFact(fact.id)}
                >
                  <X className="size-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))}
          {confirmed.map((fact) => (
            <div key={fact.id} className="flex flex-row items-center gap-2">
              <Check className="size-4 shrink-0 text-primary" />
              <span className="text-sm text-muted-foreground">
                {fact.label}: {fact.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
