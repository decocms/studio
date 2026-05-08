import { cn } from "@deco/ui/lib/utils.ts";
import { Terminal } from "@untitledui/icons";
import type { ReactNode } from "react";
import { GridLoader } from "@/web/components/grid-loader";
import type { ClaimPhase } from "./hooks/vm-events-context";
import { useVmEvents } from "./hooks/use-vm-events";

interface VmBootingStateProps {
  /** Wall-clock ms when the boot began — feeds the elapsed timer. */
  since: number;
  hasSetupData: boolean;
  /** npm scripts discovered in the repo (emitted after install completes). */
  scripts: string[];
  activeProcesses: string[];
  onViewLogs: () => void;
  /**
   * Pre-daemon lifecycle phase (agent-sandbox runner only). When non-null
   * and not `ready`, the component renders a lifecycle-driven pre-daemon
   * UI; otherwise it falls through to the existing 3-phase daemon-driven
   * UI. Callers pass `null` when the runner doesn't surface lifecycle
   * phases (Docker/Freestyle) or once the lifecycle has reached `ready`
   * AND VM_START has resolved (so we don't flash back to lifecycle copy).
   */
  claimPhase?: ClaimPhase | null;
  /** Optional retry handler shown on terminal `failed` phases. */
  onRetry?: () => void;
}

const PHASES = [
  { key: "sandbox", label: "Setting up your workspace" },
  { key: "setup", label: "Installing packages" },
  { key: "server", label: "Starting your preview" },
] as const;

/**
 * 2-shade monochrome palette. Everything inside windows uses exactly these two.
 * Foreground opacities are deliberately close so the overall read is uniform.
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

/** Collapse 4 daemon signals into the 3 user-facing phases. */
function getPhaseIndex(
  hasSetupData: boolean,
  scripts: string[],
  activeProcesses: string[],
): number {
  if (activeProcesses.length > 0) return 2;
  if (hasSetupData || scripts.length > 0) return 1;
  return 0;
}

/** Strip ANSI color + cursor escape sequences from terminal output. */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes use control chars
  // oxlint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Pick the most recent non-empty terminal line across relevant sources. */
function latestLogLine(
  getBuffer: (source: string) => string,
  activeProcesses: string[],
): string | null {
  const sources = [...activeProcesses, "setup"];
  for (const source of sources) {
    const buffer = getBuffer(source);
    if (!buffer) continue;
    const lines = stripAnsi(buffer).split(/\r\n|\r|\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (line) return line;
    }
  }
  return null;
}

export function VmBootingState({
  hasSetupData,
  scripts,
  activeProcesses,
  onViewLogs,
  claimPhase,
  onRetry,
}: VmBootingStateProps) {
  // Lifecycle-driven pre-daemon UI takes precedence whenever the caller
  // supplies a phase. The caller (preview.tsx) decides when to drop it —
  // typically once VM_START's promise resolves and a previewUrl is in
  // hand, so we don't briefly flash the 3-phase UI between
  // Sandbox.Ready=True and VM_START.success.
  if (claimPhase != null) {
    return (
      <ClaimLifecycleView
        phase={claimPhase}
        onRetry={onRetry}
        onViewLogs={onViewLogs}
      />
    );
  }

  const phase = getPhaseIndex(hasSetupData, scripts, activeProcesses);
  const currentLabel = PHASES[phase]?.label ?? PHASES[0].label;

  const { getBuffer } = useVmEvents();
  const lastLogLine = latestLogLine(getBuffer, activeProcesses);

  return (
    <div className="relative flex flex-col items-center justify-center w-full h-full overflow-hidden select-none gap-8">
      <div className="flex items-center gap-2 rounded-full border border-foreground/10 bg-background px-3.5 py-1.5 shadow-[0_4px_20px_-4px_rgb(0_0_0_/_0.12)]">
        <GridLoader />
        <span
          key={PHASES[phase]?.key ?? "sandbox"}
          className="text-[13px] font-medium text-foreground/85 animate-in fade-in duration-500"
        >
          {currentLabel}…
        </span>
      </div>

      <div className="relative w-[min(78%,560px)] aspect-[4/3]">
        <PhaseCard phase={0} current={phase}>
          <SandboxContent />
        </PhaseCard>
        <PhaseCard phase={1} current={phase}>
          <SetupContent />
        </PhaseCard>
        <PhaseCard phase={2} current={phase}>
          <PreviewContent />
        </PhaseCard>
      </div>

      {/* Log line + View logs — stacked, same type, subtle */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 max-w-[80%] min-w-0">
        {lastLogLine && (
          <span
            key={lastLogLine}
            className="block w-full max-w-[440px] truncate text-center text-xs font-mono text-muted-foreground/45 animate-in fade-in duration-300"
          >
            {lastLogLine}
          </span>
        )}
        <button
          type="button"
          onClick={onViewLogs}
          className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-200"
        >
          <Terminal size={11} />
          View logs
        </button>
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
  // Done card sits below; upcoming cards stack behind the active one.
  const zIndex = isDone ? 10 : 30 - offset;

  return (
    <div
      aria-hidden={!isActive}
      className={cn(
        "absolute inset-0 rounded-xl border border-foreground/10 bg-background shadow-[0_20px_60px_-20px_rgb(0_0_0_/_0.35)] overflow-hidden transition-all ease-[cubic-bezier(0.22,1,0.36,1)]",
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

/** Traffic-light dots + optional URL pill. No separator line, no bg tint. */
function BrowserChrome({ showUrl = false }: { showUrl?: boolean }) {
  return (
    <div className="h-7 flex items-center gap-1.5 px-3 shrink-0">
      <div className={cn("w-2.5 h-2.5 rounded-full", MUTED_2)} />
      <div className={cn("w-2.5 h-2.5 rounded-full", MUTED_2)} />
      <div className={cn("w-2.5 h-2.5 rounded-full", MUTED_2)} />
      {showUrl && (
        <div
          className={cn("ml-3 h-3.5 flex-1 max-w-[220px] rounded-sm", MUTED_1)}
        />
      )}
    </div>
  );
}

/** Phase 1: wireframe of the app layout — faint outline that phase 3 will fill. */
function SandboxContent() {
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome />
      <div className="flex flex-1 min-h-0 gap-1.5 p-3">
        <div
          className={cn("w-[18%] rounded-md", MUTED_1)}
          style={{ animation: "vm-breathe 3s ease-in-out infinite" }}
        />
        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          <div
            className="h-[42%] shrink-0 rounded-md bg-chart-3/[0.12]"
            style={{ animation: "vm-breathe 3s ease-in-out 0.4s infinite" }}
          />
          <div className="flex-1 grid grid-cols-5 gap-1.5 min-h-0">
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

/** Phase 2: grid of tiles pulsing at random — "items arriving". */
function SetupContent() {
  const cols = 7;
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome />
      <div className="relative flex-1 flex items-center justify-center px-8 py-5">
        <div
          className="grid gap-2 w-full"
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

/** Phase 3: app surface — sidebar + hero + asymmetric card grid. No borders. */
function PreviewContent() {
  return (
    <div className="flex h-full flex-col">
      <BrowserChrome showUrl />
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-[18%] p-2.5 flex flex-col gap-1.5 shrink-0 bg-chart-1/[0.05]">
          <div className="h-5 rounded-md mb-2 bg-chart-1/[0.10]" />
          <div className={cn("h-1.5 rounded-sm w-[70%]", MUTED_2)} />
          <div className={cn("h-1.5 rounded-sm w-[55%]", MUTED_2)} />
          <div className={cn("h-1.5 rounded-sm w-[80%]", MUTED_2)} />
          <div className={cn("h-1.5 rounded-sm w-[50%]", MUTED_2)} />
          <div className="mt-auto">
            <div className={cn("h-4 rounded-md", MUTED_2)} />
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Hero — chart-1 tint */}
          <div className="relative h-[42%] shrink-0 overflow-hidden bg-chart-1/[0.10]">
            <div className="absolute bottom-3 left-3 right-3 space-y-1.5">
              <div className="h-3 rounded-sm w-[35%] bg-chart-1/[0.15]" />
              <div className={cn("h-1.5 rounded-sm w-[55%]", MUTED_1)} />
            </div>
          </div>

          {/* Content body */}
          <div className="flex-1 p-3 flex flex-col gap-2.5 min-h-0">
            <div className="flex gap-1.5 shrink-0">
              <div className="h-4 w-12 rounded-full bg-chart-1/[0.12]" />
              <div className={cn("h-4 w-10 rounded-full", MUTED_1)} />
              <div className={cn("h-4 w-14 rounded-full", MUTED_1)} />
            </div>

            <div className="flex-1 grid grid-cols-5 gap-2 min-h-0">
              <div
                className={cn(
                  "col-span-3 rounded-md flex flex-col justify-end p-2 gap-1",
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

// ---- Lifecycle (pre-daemon) UI --------------------------------------------

/**
 * Copy for each pre-daemon phase. Headlines stay short for the pill;
 * `body` is only shown for phases where the user benefits from knowing why
 * the wait exists (capacity provisioning, image pull on a fresh node).
 *
 * `failed` is intentionally absent here — failure copy is phase-reason
 * driven (see `failureCopy`) and renders a Try-Again affordance.
 */
const LIFECYCLE_COPY: Record<
  Exclude<ClaimPhase["kind"], "ready" | "failed">,
  { headline: string; body?: string }
> = {
  claiming: {
    headline: "Reserving sandbox",
    body: "Posting your claim to the cluster…",
  },
  "waiting-for-capacity": {
    headline: "Waiting for cluster capacity",
    body: "The cluster may need to provision a new node — typically 60–90s.",
  },
  "pulling-image": {
    headline: "Downloading sandbox image",
    body: "First boot on this node — subsequent runs reuse the cached image.",
  },
  "starting-container": {
    headline: "Starting your sandbox",
  },
  "warming-daemon": {
    headline: "Connecting to your sandbox",
  },
};

function failureCopy(phase: Extract<ClaimPhase, { kind: "failed" }>): {
  headline: string;
  body: string;
} {
  switch (phase.reason) {
    case "image-pull-backoff":
      return {
        headline: "Sandbox image failed to download",
        body: phase.message,
      };
    case "crash-loop-backoff":
      return {
        headline: "Sandbox crashed during startup",
        body: phase.message,
      };
    case "scheduling-timeout":
      return {
        headline: "Couldn't get cluster capacity in time",
        body: phase.message,
      };
    case "claim-never-created":
      return {
        headline: "Sandbox claim was never posted",
        body: phase.message,
      };
    case "reconciler-error":
      return {
        headline: "Sandbox controller reported an error",
        body: phase.message,
      };
    case "unknown":
    default:
      return {
        headline: "Sandbox failed to start",
        body: phase.message,
      };
  }
}

function ClaimLifecycleView({
  phase,
  onRetry,
  onViewLogs,
}: {
  phase: ClaimPhase;
  onRetry?: () => void;
  onViewLogs: () => void;
}) {
  if (phase.kind === "failed") {
    const copy = failureCopy(phase);
    return (
      <div className="relative flex flex-col items-center justify-center w-full h-full overflow-hidden select-none gap-6 px-6">
        <div className="flex flex-col items-center gap-2 text-center max-w-[440px]">
          <span className="text-sm font-medium text-foreground">
            {copy.headline}
          </span>
          <span className="text-xs text-muted-foreground">{copy.body}</span>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-foreground/15 bg-background px-3 py-1.5 text-xs font-medium hover:bg-foreground/[0.04] transition-colors"
          >
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={onViewLogs}
          className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-200"
        >
          <Terminal size={11} />
          View logs
        </button>
      </div>
    );
  }

  // `ready` is reached when Sandbox.Ready=True, but VM_START still has the
  // Service-patch + HTTPRoute-mint + port-forward window before previewUrl
  // exists. Show "almost ready" until the caller drops `claimPhase`
  // (= VM_START's promise resolved).
  const copy =
    phase.kind === "ready"
      ? { headline: "Almost ready", body: undefined }
      : LIFECYCLE_COPY[phase.kind];
  const subline =
    phase.kind === "ready" ? undefined : (nodeClaimSubline(phase) ?? copy.body);

  return (
    <div className="relative flex flex-col items-center justify-center w-full h-full overflow-hidden select-none gap-6">
      <div className="flex items-center gap-2 rounded-full border border-foreground/10 bg-background px-3.5 py-1.5 shadow-[0_4px_20px_-4px_rgb(0_0_0_/_0.12)]">
        <GridLoader />
        <span
          key={phase.kind}
          className="text-[13px] font-medium text-foreground/85 animate-in fade-in duration-500"
        >
          {copy.headline}…
        </span>
      </div>

      {subline && (
        <span
          key={subline}
          className="block max-w-[440px] truncate text-center text-xs text-muted-foreground/70 animate-in fade-in duration-300"
        >
          {subline}
        </span>
      )}

      <button
        type="button"
        onClick={onViewLogs}
        className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-200"
      >
        <Terminal size={11} />
        View logs
      </button>
    </div>
  );
}

function nodeClaimSubline(phase: ClaimPhase): string | undefined {
  if (phase.kind !== "waiting-for-capacity") return undefined;
  if (!phase.nodeClaim) return undefined;
  return `Provisioning node ${phase.nodeClaim}…`;
}
