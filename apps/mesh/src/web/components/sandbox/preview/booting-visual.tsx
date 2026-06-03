import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { GridLoader } from "@/web/components/grid-loader";
import type { ClaimPhase } from "../hooks/sandbox-events-context";
import { CLAIM_PHASE_COPY } from "../claim-phase-copy";
import type { PhaseKey, PhaseProgress } from "./derive-phase-progress";
import { activePhaseIndex } from "./state-card-helpers";
import {
  RACK_SCAN_DELAYS,
  RACK_SCAN_PERIOD_SEC,
  RESERVED_SLOT_INDEX,
} from "./provision-rack";

/**
 * The starting booting visual: a GridLoader pill with a phase-aware
 * headline, plus a 4-card stacked illustration that advances as the runner
 * progresses through provision → cloning → install → dev. While the daemon
 * is still pre-claim (agent-sandbox lifecycle) the pill copy overlays
 * sub-phase wording without changing the card stack.
 *
 * Pure presentational. Log lines and "View logs" affordance live one level
 * up in `state-card.tsx` so they survive across all 4 state kinds.
 */
export interface BootingVisualProps {
  progress: PhaseProgress;
  /** When provided AND step is "provision" AND kind != "ready", drives lifecycle copy. */
  claimPhase: ClaimPhase | null;
}

const PHASE_LABELS: Record<PhaseKey, string> = {
  provision: "Reserving sandbox",
  cloning: "Cloning your repo",
  install: "Installing packages",
  dev: "Starting your preview",
};

function pillHeadline(
  progress: PhaseProgress,
  claimPhase: ClaimPhase | null,
): string {
  if (
    progress.step === "provision" &&
    claimPhase != null &&
    claimPhase.kind !== "ready" &&
    claimPhase.kind !== "failed"
  ) {
    return CLAIM_PHASE_COPY[claimPhase.kind].long;
  }
  return PHASE_LABELS[progress.step];
}

/**
 * 2-shade monochrome palette. Everything inside windows uses exactly these two.
 */
const MUTED_1 = "bg-foreground/[0.05]";
const MUTED_2 = "bg-foreground/[0.09]";

/** Stable "random" delays per tile — generated once at module load. */
const PACKAGE_TILE_DELAYS = Array.from(
  { length: 35 },
  () => Math.random() * 1.8,
);

/** ~40% of tiles get the chart-2 accent; the rest stay muted. */
const PACKAGE_TILE_COLORED = Array.from(
  { length: 35 },
  () => Math.random() < 0.4,
);

export function BootingVisual({ progress, claimPhase }: BootingVisualProps) {
  const activeIndex = activePhaseIndex(progress);
  const headline = pillHeadline(progress, claimPhase);

  return (
    <div className="relative flex w-full flex-col items-center justify-center gap-12 select-none [clip-path:inset(-24px_0_-200px_0)]">
      <div className="flex items-center gap-2 rounded-full border border-foreground/10 bg-background px-3.5 py-1.5 shadow-[0_4px_20px_-4px_rgb(0_0_0_/_0.12)]">
        <GridLoader />
        <span
          key={`${progress.step}-${headline}`}
          className="animate-in fade-in text-[13px] font-medium text-foreground/85 duration-500"
        >
          {headline}…
        </span>
      </div>

      <div className="relative aspect-[4/3] w-[min(78%,560px)]">
        <PhaseCard phase={0} current={activeIndex}>
          <ProvisionContent />
        </PhaseCard>
        <PhaseCard phase={1} current={activeIndex}>
          <CloningContent />
        </PhaseCard>
        <PhaseCard phase={2} current={activeIndex}>
          <InstallContent />
        </PhaseCard>
        <PhaseCard phase={3} current={activeIndex}>
          <PreviewContent />
        </PhaseCard>
      </div>

      <style>{`
        @keyframes vm-pulse-soft {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 1; }
        }
        @keyframes vm-breathe {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes vm-rack-scan {
          0%, 100% { opacity: 0; }
          8% { opacity: 1; }
          22% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function PhaseCard({
  phase,
  current,
  children,
}: {
  phase: number;
  current: number;
  children: ReactNode;
}) {
  const offset = phase - current;
  const isDone = offset < 0;
  const isActive = offset === 0;

  // Upcoming cards peek from ABOVE the active one. On completion the active
  // card fades down while the next descends to take its place.
  const translateY = isDone ? 90 : offset * -22;
  const scale = isDone ? 0.94 : 1 - Math.max(offset, 0) * 0.04;
  const opacity = isDone ? 0 : isActive ? 1 : offset === 1 ? 0.8 : 0.55;
  const zIndex = isDone ? 10 : 30 - offset;

  return (
    <div
      aria-hidden={!isActive}
      className={cn(
        "absolute inset-0 overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-[0_20px_60px_-20px_rgb(0_0_0_/_0.35)] transition-all ease-[cubic-bezier(0.22,1,0.36,1)]",
      )}
      style={{
        transform: `translateY(${translateY}px) scale(${scale})`,
        opacity,
        zIndex,
        transitionDuration: "1000ms",
        pointerEvents: isActive ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

/** Traffic-light dots + optional URL pill. */
function BrowserChrome({ showUrl = false }: { showUrl?: boolean }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 px-3">
      <div className={cn("size-2.5 rounded-full", MUTED_2)} />
      <div className={cn("size-2.5 rounded-full", MUTED_2)} />
      <div className={cn("size-2.5 rounded-full", MUTED_2)} />
      {showUrl && (
        <div
          className={cn("ml-3 h-3.5 max-w-[220px] flex-1 rounded-sm", MUTED_1)}
        />
      )}
    </div>
  );
}

/**
 * Phase 0: 8×6 capacity rack. A chart-1 scanner highlight sweeps across
 * the muted tiles while one persistent chart-1 tile sits at
 * RESERVED_SLOT_INDEX, reading as "your sandbox slot is claimed."
 *
 * Padding (`px-8 py-5`) and gap (`gap-2`) match `InstallContent` so the
 * provision and install grids share the same outer rhythm. Tiles are
 * sized by the grid (no `aspect-square`) so 48 cells fit cleanly inside
 * the card's 4/3 aspect — the 8/6 grid ratio matches the card's 4/3, so
 * tiles come out close to square.
 */
function ProvisionContent() {
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome />
      <div className="flex flex-1 px-8 py-5">
        <div className="grid h-full w-full grid-cols-8 grid-rows-6 gap-2">
          {RACK_SCAN_DELAYS.map((delay, i) => {
            if (i === RESERVED_SLOT_INDEX) {
              return (
                <div
                  key={i}
                  className="rounded-md bg-chart-1/[0.55]"
                  style={{
                    animation: "vm-breathe 2.4s ease-in-out infinite",
                  }}
                />
              );
            }
            // `delay` is `number | null`; the `null` entry sits at RESERVED_SLOT_INDEX,
            // which the early-return above already handled — so on this branch it's
            // always a number. Narrow with an assertion rather than a `?? 0` fallback
            // (which would silently substitute 0 for a case that cannot occur).
            const scanDelay = delay as number;
            return (
              <div key={i} className={cn("relative rounded-md", MUTED_2)}>
                <div
                  className="absolute inset-0 rounded-md bg-chart-1/40 opacity-0"
                  style={{
                    animation: `vm-rack-scan ${RACK_SCAN_PERIOD_SEC}s ease-in-out infinite`,
                    animationDelay: `${scanDelay}s`,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Phase 1: wireframe of the app layout — the cloned workspace materializing. */
function CloningContent() {
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome />
      <div className="flex min-h-0 flex-1 gap-1.5 p-3">
        <div
          className={cn("w-[18%] rounded-md", MUTED_1)}
          style={{ animation: "vm-breathe 3s ease-in-out infinite" }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div
            className="h-[42%] shrink-0 rounded-md bg-chart-3/[0.12]"
            style={{ animation: "vm-breathe 3s ease-in-out 0.4s infinite" }}
          />
          <div className="grid min-h-0 flex-1 grid-cols-5 gap-1.5">
            <div
              className="col-span-3 rounded-md bg-chart-3/[0.12]"
              style={{ animation: "vm-breathe 3s ease-in-out 0.8s infinite" }}
            />
            <div className="col-span-2 grid grid-rows-2 gap-1.5">
              <div
                className={cn("rounded-md", MUTED_1)}
                style={{ animation: "vm-breathe 3s ease-in-out 1.2s infinite" }}
              />
              <div
                className={cn("rounded-md", MUTED_1)}
                style={{ animation: "vm-breathe 3s ease-in-out 1.6s infinite" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Phase 2: grid of tiles pulsing at random — packages arriving. */
function InstallContent() {
  const cols = 7;
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome />
      <div className="relative flex flex-1 items-center justify-center px-8 py-5">
        <div
          className="grid w-full gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {PACKAGE_TILE_DELAYS.map((delay, i) => (
            <div
              key={i}
              className={cn(
                "aspect-square rounded-md",
                PACKAGE_TILE_COLORED[i] ? "bg-chart-2/70" : MUTED_2,
              )}
              style={{
                animation: `vm-pulse-soft 2.2s ease-in-out ${delay}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Phase 3: app surface — sidebar + hero + asymmetric card grid. */
function PreviewContent() {
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome showUrl />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[18%] shrink-0 flex-col gap-1.5 bg-chart-1/[0.05] p-2.5">
          <div className="mb-2 h-5 rounded-md bg-chart-1/[0.10]" />
          <div className={cn("h-1.5 w-[70%] rounded-sm", MUTED_2)} />
          <div className={cn("h-1.5 w-[55%] rounded-sm", MUTED_2)} />
          <div className={cn("h-1.5 w-[80%] rounded-sm", MUTED_2)} />
          <div className={cn("h-1.5 w-[50%] rounded-sm", MUTED_2)} />
          <div className="mt-auto">
            <div className={cn("h-4 rounded-md", MUTED_2)} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative h-[42%] shrink-0 overflow-hidden bg-chart-1/[0.10]">
            <div className="absolute right-3 bottom-3 left-3 space-y-1.5">
              <div className="h-3 w-[35%] rounded-sm bg-chart-1/[0.15]" />
              <div className={cn("h-1.5 w-[55%] rounded-sm", MUTED_1)} />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
            <div className="flex shrink-0 gap-1.5">
              <div className="h-4 w-12 rounded-full bg-chart-1/[0.12]" />
              <div className={cn("h-4 w-10 rounded-full", MUTED_1)} />
              <div className={cn("h-4 w-14 rounded-full", MUTED_1)} />
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-5 gap-2">
              <div
                className={cn(
                  "col-span-3 flex flex-col justify-end gap-1 rounded-md p-2",
                  MUTED_1,
                )}
              >
                <div className={cn("h-1.5 w-[50%] rounded-sm", MUTED_2)} />
                <div className={cn("h-1 w-[75%] rounded-sm", MUTED_2)} />
              </div>
              <div className="col-span-2 grid grid-rows-2 gap-2">
                <div className={cn("rounded-md", MUTED_1)} />
                <div className={cn("rounded-md", MUTED_1)} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
