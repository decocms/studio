import { useInstallApp } from "@/web/hooks/use-install-app";
import { useTelosGoal } from "@/web/hooks/use-telos-goal";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Lightbulb02,
  LinkExternal01,
  Loading01,
  Target04,
  X,
} from "@untitledui/icons";

const SUGGESTION_LABELS: Record<string, string> = {
  connect_a_tool: "Connect a tool",
};

const suggestionLabel = (kind: string): string =>
  SUGGESTION_LABELS[kind] ?? kind.replace(/_/g, " ");

const sourceHost = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

const normalizeAppId = (appId: string): string => appId.replace(/^@/, "");

export function TelosGoalCard({ orgSlug }: { orgSlug: string }) {
  const { goal, facts, suggestion, progress, status, confirmFact, rejectFact } =
    useTelosGoal(orgSlug);
  const queryClient = useQueryClient();
  // Clicking a tool installs it in place — the exact flow the "Import GitHub"
  // button uses (fetch app detail → create connection → OAuth), generalized.
  const { install, activeAppId, isBusy } = useInstallApp({
    onConnected: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.telosGoal(orgSlug) }),
  });

  // Merge the goal's tools (label/appName/icon) with live progress (connected).
  const tools =
    goal?.tools.map((t) => ({
      label: t.label,
      appName: t.appName,
      icon: t.icon,
      connected: progress?.find((p) => p.label === t.label)?.connected ?? false,
      installing:
        isBusy && !!t.appName && activeAppId === normalizeAppId(t.appName),
    })) ?? [];

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
            {tools.length > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                {tools.map((tool) => (
                  <button
                    type="button"
                    key={tool.label}
                    disabled={tool.connected || isBusy}
                    onClick={() => install(tool.appName)}
                    className={cn(
                      "group flex w-fit flex-row items-center gap-2 text-xs",
                      !tool.connected && "cursor-pointer hover:underline",
                    )}
                  >
                    {tool.connected ? (
                      <Check className="size-3.5 shrink-0 text-primary" />
                    ) : tool.installing ? (
                      <Loading01 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <div className="size-3.5 shrink-0 rounded-full border border-muted-foreground/40" />
                    )}
                    {tool.icon && (
                      <img
                        src={tool.icon}
                        alt=""
                        className="size-3.5 shrink-0 rounded-sm object-cover"
                      />
                    )}
                    <span
                      className={cn(
                        tool.connected
                          ? "text-muted-foreground line-through"
                          : "text-foreground",
                      )}
                    >
                      {tool.label}
                    </span>
                    {!tool.connected && (
                      <span className="text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        {tool.installing ? "Connecting…" : "Connect →"}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {goal && suggestion && (
        <div className="flex flex-row items-start gap-3 rounded-md bg-muted/50 p-3">
          <div className="mt-0.5 text-primary">
            <Lightbulb02 className="size-5" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recommended next step
            </span>
            <span className="text-sm font-medium text-foreground">
              {suggestionLabel(suggestion.kind)}
            </span>
            {suggestion.reason && (
              <span className="text-xs text-muted-foreground">
                {suggestion.reason}
              </span>
            )}
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
