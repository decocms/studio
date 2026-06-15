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
import { DemoProviders } from "./demo-providers";
import { createDemoStores } from "./director-stores";
import { Director } from "./director";
import { runAutoplay } from "./runner";
import { useCaption } from "./use-demo-stores";
import { GhostCursor } from "./ghost-cursor";
import { EndCard } from "./end-card";
import type { DemoStores } from "./director-stores";
import type { Scenario } from "./types";

const DEFAULT_END = {
  title: "Build this on your own data",
  subtitle: "Spin up your first agent in minutes — free to start.",
};

function DemoCaption({ stores }: { stores: DemoStores }) {
  const caption = useCaption(stores);
  if (!caption) return null;
  return (
    <div className="pointer-events-none absolute bottom-7 left-1/2 z-50 -translate-x-1/2">
      {/* key on text so each new caption fades/slides in fresh */}
      <div
        key={caption}
        className="animate-in fade-in slide-in-from-bottom-2 duration-500 rounded-full bg-foreground/90 px-4 py-1.5 text-sm font-medium text-background shadow-lg backdrop-blur"
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
        <GhostCursor stores={stores} />
        <EndCard
          stores={stores}
          title={active.endCard?.title ?? DEFAULT_END.title}
          subtitle={active.endCard?.subtitle ?? DEFAULT_END.subtitle}
        />
      </div>
    </DemoProviders>
  );
}
