/**
 * Demo Mode — end card.
 *
 * Shown after a full play-through (instead of silently looping). Offers a
 * replay or a sign-up CTA. Driven by `ui.ended`; "Replay" bumps `replayToken`
 * which the runner's `awaitReplay()` is waiting on.
 */
import { useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowRight, RefreshCcw01 } from "@untitledui/icons";
import type { DemoStores } from "./director-stores";

export function EndCard({
  stores,
  title,
  subtitle,
}: {
  stores: DemoStores;
  title: string;
  subtitle: string;
}) {
  const ended = useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().ended,
    () => stores.ui.get().ended,
  );
  const navigate = useNavigate();
  if (!ended) return null;

  const replay = () =>
    stores.ui.update((s) => ({
      ...s,
      ended: false,
      replayToken: s.replayToken + 1,
    }));

  return (
    <div className="absolute inset-0 z-[120] flex items-center justify-center bg-background/70 backdrop-blur-sm animate-in fade-in duration-500">
      <div className="animate-in fade-in zoom-in-95 duration-500 w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            type="button"
            onClick={() => navigate({ to: "/login" })}
            className="w-full gap-2"
          >
            Get started free
            <ArrowRight className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={replay}
            className="w-full gap-2 text-muted-foreground"
          >
            <RefreshCcw01 className="size-4" />
            Watch again
          </Button>
        </div>
      </div>
    </div>
  );
}
