/**
 * Demo Mode — the stage.
 *
 * Full-screen surface that runs the autoplay loop and renders the ACTIVE
 * scenario's own layout (`scenario.Stage`). The Director owns all timing
 * outside React; the only `useEffect` here is the runner's start/abort
 * lifecycle boundary (same documented exception pattern as
 * `components/live-timer.tsx`).
 */
import { useEffect, useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { PlayCircle, VolumeX } from "@untitledui/icons";
import { DemoProviders } from "./demo-providers";
import { createDemoStores } from "./director-stores";
import { Director } from "./director";
import { runAutoplay } from "./runner";
import { useCaption, useDemoInput } from "./use-demo-stores";
import { GhostCursor } from "./ghost-cursor";
import { EndCard } from "./end-card";
import { createVoicePlayer, VoiceToggle } from "./voiceover";
import type { DemoStores } from "./director-stores";
import type { Scenario } from "./types";

const DEFAULT_END = {
  title: "Build this on your own data",
  subtitle: "Spin up your first agent in minutes — free to start.",
};

/** The gate before the show: one click starts the run AND unlocks audio, so
 *  the first narration line actually narrates. */
function StartCard({ stores, title }: { stores: DemoStores; title: string }) {
  const started = useDemoInput(stores, "started") === "1";
  if (started) return null;

  const start = (vo: "on" | "off") =>
    stores.ui.update((s) => ({
      ...s,
      inputs: { ...s.inputs, started: "1", vo: vo === "off" ? "off" : "" },
    }));

  return (
    <div className="absolute inset-0 z-[120] flex items-center justify-center bg-background/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-2xl animate-in fade-in zoom-in-95 duration-500">
        <img
          src="/logos/deco logo.svg"
          alt=""
          className="mx-auto mb-4 size-10 select-none"
        />
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A 2-minute guided tour, narrated. Press Esc anytime to pause.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            type="button"
            onClick={() => start("on")}
            className="w-full gap-2"
          >
            <PlayCircle className="size-4" />
            Play with narration
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => start("off")}
            className="w-full gap-2 text-muted-foreground"
          >
            <VolumeX className="size-4" />
            Watch muted
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Esc toggles the Director's clock; this pill says so while paused. */
function PausedPill({ stores }: { stores: DemoStores }) {
  const paused = useDemoInput(stores, "paused") === "1";
  if (!paused) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-20 z-[115] -translate-x-1/2 animate-in fade-in duration-300">
      <div className="rounded-full bg-foreground/90 px-4 py-2 text-sm font-medium text-background shadow-xl backdrop-blur">
        ⏸ Paused — press Esc to resume
      </div>
    </div>
  );
}

function DemoCaption({ stores }: { stores: DemoStores }) {
  const caption = useCaption(stores);
  if (!caption) return null;
  return (
    // Top of the stage (clear of the breadcrumb) — the bottom sat over the
    // composer and was easy to miss. Purple so it stands apart from the
    // product UI: this is the narrator, not a component.
    <div className="pointer-events-none absolute left-1/2 top-6 z-50 -translate-x-1/2">
      {/* key on text so each new caption fades/slides in fresh */}
      <div
        key={caption}
        className="animate-in fade-in slide-in-from-top-2 duration-500 rounded-full bg-violet-950/70 px-5 py-2.5 text-[15px] font-medium text-violet-50 shadow-xl ring-1 ring-violet-400/40 backdrop-blur-md"
      >
        {caption}
      </div>
    </div>
  );
}

/**
 * One autoplay loop per `DemoStores` instance, kept OUTSIDE React's effect
 * lifecycle. The dev runtime (React Compiler / StrictMode) re-runs passive
 * effects while preserving state, which would otherwise abort + restart the
 * scenario mid-play. We key the running loop on the (mount-stable) stores
 * instance and set it up once; teardown is deferred so a transient
 * teardown→setup cycle (which re-sets `keep`) never kills it — only a real
 * unmount, where no setup follows, aborts.
 */
const RUNNERS = new WeakMap<
  DemoStores,
  { controller: AbortController; keep: boolean }
>();

export function DemoStage({ scenarios }: { scenarios: Scenario[] }) {
  const [stores] = useState(createDemoStores);
  // Pin scenarios on mount so an unstable prop (a fresh array literal each
  // parent render) can't influence the runner.
  const [pinnedScenarios] = useState(() => scenarios);
  const [activeIndex, setActiveIndex] = useState(0);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect, eslint-plugin-react-hooks/exhaustive-deps -- runner lifecycle (start/abort) is singleton-guarded per stores; all timing lives in the Director
  useEffect(() => {
    // Demo always renders in light mode (overrides the app's theme preference).
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    root.classList.remove("dark");

    let entry = RUNNERS.get(stores);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, keep: true };
      RUNNERS.set(stores, entry);
      const director = new Director(stores, controller.signal);
      const stopVoice = createVoicePlayer(stores);
      controller.signal.addEventListener("abort", stopVoice, { once: true });
      // Esc toggles pause (only mid-show — not on the start/end cards).
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        const { inputs, ended } = stores.ui.get();
        if (inputs.started !== "1" || ended) return;
        stores.ui.update((s) => ({
          ...s,
          inputs: {
            ...s.inputs,
            paused: s.inputs.paused === "1" ? "" : "1",
          },
        }));
      };
      window.addEventListener("keydown", onKey);
      controller.signal.addEventListener(
        "abort",
        () => window.removeEventListener("keydown", onKey),
        { once: true },
      );
      void runAutoplay(
        director,
        pinnedScenarios,
        controller.signal,
        setActiveIndex,
      );
    }
    entry.keep = true; // setup cancels any pending teardown

    return () => {
      const e = RUNNERS.get(stores);
      if (e) {
        e.keep = false;
        queueMicrotask(() => {
          // A synchronous re-setup (StrictMode / spurious re-run) flips `keep`
          // back to true before this runs → loop survives. Real unmount leaves
          // it false → abort.
          if (!e.keep) {
            e.controller.abort();
            RUNNERS.delete(stores);
          }
        });
      }
      if (wasDark) root.classList.add("dark");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = pinnedScenarios[activeIndex] ?? pinnedScenarios[0]!;
  const ActiveStage = active.Stage;

  return (
    <DemoProviders>
      <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background">
        <ActiveStage stores={stores} />
        <DemoCaption stores={stores} />
        <PausedPill stores={stores} />
        <VoiceToggle stores={stores} />
        <GhostCursor stores={stores} />
        <StartCard stores={stores} title={active.title} />
        <EndCard
          stores={stores}
          title={active.endCard?.title ?? DEFAULT_END.title}
          subtitle={active.endCard?.subtitle ?? DEFAULT_END.subtitle}
        />
      </div>
    </DemoProviders>
  );
}
