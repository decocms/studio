/**
 * Demo Mode — end card.
 *
 * Shown after a full play-through (instead of silently looping). Offers a
 * replay, a sign-up CTA, or DISMISS — the finished stage stays on screen so
 * viewers can click around the final state (crumbs, agents, org cards, share
 * are live). A floating pill brings the card back / replays. Driven by
 * `ui.ended` + the `endcard` input; "Replay" bumps `replayToken` which the
 * runner's `awaitReplay()` is waiting on.
 */
import { useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowRight, RefreshCcw01, XClose } from "@untitledui/icons";
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
  const dismissed = useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().inputs.endcard === "dismissed",
    () => stores.ui.get().inputs.endcard === "dismissed",
  );
  const navigate = useNavigate();
  if (!ended) return null;

  const replay = () =>
    stores.ui.update((s) => ({
      ...s,
      ended: false,
      inputs: { ...s.inputs, endcard: "" },
      replayToken: s.replayToken + 1,
    }));

  const setDismissed = (value: string) =>
    stores.ui.update((s) => ({
      ...s,
      inputs: { ...s.inputs, endcard: value },
    }));

  if (dismissed) {
    // Explore mode: the stage stays interactive; a pill restarts the show.
    return (
      <div className="absolute bottom-5 right-5 z-[120] flex gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={replay}
          className="gap-1.5 shadow-lg"
        >
          <RefreshCcw01 className="size-3.5" />
          Replay demo
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => navigate({ to: "/login" })}
          className="gap-1.5 shadow-lg"
        >
          Get started
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-[120] flex items-center justify-center bg-background/70 backdrop-blur-sm animate-in fade-in duration-500">
      <div className="relative animate-in fade-in zoom-in-95 duration-500 w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
        <button
          type="button"
          onClick={() => setDismissed("dismissed")}
          aria-label="Dismiss and explore"
          className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XClose size={16} />
        </button>
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
          <button
            type="button"
            onClick={() => setDismissed("dismissed")}
            className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            or dismiss and click around the final state
          </button>
        </div>
      </div>
    </div>
  );
}
