import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Monitor04,
  PauseCircle,
  Play,
  RefreshCw01,
} from "@untitledui/icons";
import { BootingVisual } from "./booting-visual";
import { VmTerminal } from "./drawer/terminal";
import type { ClaimPhase } from "../hooks/vm-events-context";
import type { PhaseProgress, PhaseStatus } from "./derive-phase-progress";
import {
  formatElapsed,
  headlineFor,
  phaseStatusFor,
  phaseTickGlyph,
} from "./state-card-helpers";
import type { StateCardKind } from "./state-card-types";

export type VmStateCardProps =
  | { kind: "never-started"; onStart: () => void }
  | {
      kind: "starting-now";
      progress: PhaseProgress;
      claimPhase: ClaimPhase | null;
      /** Source name for the inline log peek's xterm (e.g. "setup"). */
      logSource: string;
      elapsed: number; // ms
      /** Toggle the terminal drawer open/closed. */
      onToggleLogs: () => void;
      /** When the drawer is open it already shows the same logs in full;
       *  hide the inline peek (mutually exclusive surfaces). */
      drawerOpen: boolean;
    }
  | {
      kind: "errored";
      progress: PhaseProgress;
      logSource: string;
      errorLine: string;
      elapsed: number; // ms
      onRetry: () => void;
      onToggleLogs: () => void;
      /** Same as starting-now — drawer-open hides the inline peek. */
      drawerOpen: boolean;
    }
  | { kind: "suspended"; onResume: () => void };

export function VmStateCard(props: VmStateCardProps) {
  if (props.kind === "starting-now") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-between gap-4 bg-background p-6">
        <div className="flex flex-1 w-full items-center justify-center">
          <BootingVisual
            progress={props.progress}
            claimPhase={props.claimPhase}
          />
        </div>
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          {!props.drawerOpen && <LogPeek source={props.logSource} />}
          <Footer {...props} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <Glyph kind={props.kind} />
        <Headline kind={props.kind} />
        <Subline {...props} />
        {props.kind === "errored" && (
          <PhaseStripView progress={props.progress} />
        )}
        {props.kind === "errored" && !props.drawerOpen && (
          <LogPeek source={props.logSource} />
        )}
        <Footer {...props} />
      </div>
    </div>
  );
}

// `starting-now` uses BootingVisual (separate layout) so these helpers only
// render the other three kinds.
type NonBootingKind = Exclude<StateCardKind, "starting-now">;

function Glyph({ kind }: { kind: NonBootingKind }) {
  const cls = "size-12";
  switch (kind) {
    case "never-started":
      return <Monitor04 className={cn(cls, "text-muted-foreground/60")} />;
    case "errored":
      return <AlertTriangle className={cn(cls, "text-destructive")} />;
    case "suspended":
      return <PauseCircle className={cn(cls, "text-blue-500")} />;
  }
}

function Headline({ kind }: { kind: NonBootingKind }) {
  return <h3 className="text-lg font-medium">{headlineFor(kind)}</h3>;
}

function Subline(props: Exclude<VmStateCardProps, { kind: "starting-now" }>) {
  switch (props.kind) {
    case "never-started":
      return (
        <p className="max-w-sm text-sm text-muted-foreground">
          Start the dev server to render a live preview.
        </p>
      );
    case "errored":
      return (
        <p
          role="alert"
          className="max-w-sm break-words text-sm text-destructive/80"
        >
          {props.errorLine}
        </p>
      );
    case "suspended":
      return (
        <p className="max-w-sm text-sm text-muted-foreground">
          Suspended after 30 min idle to conserve resources. Resume to continue
          where you left off.
        </p>
      );
  }
}

function PhaseStripView({ progress }: { progress: PhaseProgress }) {
  return (
    <div className="flex w-full flex-col gap-1 rounded-lg border border-border bg-muted/30 px-4 py-3 text-left">
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        <PhaseTick
          label="provision"
          status={phaseStatusFor(progress, "provision")}
        />
        <PhaseTick
          label="cloning"
          status={phaseStatusFor(progress, "cloning")}
        />
        <PhaseTick
          label="install"
          status={phaseStatusFor(progress, "install")}
        />
        <PhaseTick label="dev" status={phaseStatusFor(progress, "dev")} />
      </div>
    </div>
  );
}

function PhaseTick({ label, status }: { label: string; status: PhaseStatus }) {
  const glyph = phaseTickGlyph(status);
  const cls =
    status === "done"
      ? "text-emerald-600"
      : status === "failed"
        ? "text-destructive"
        : status === "doing"
          ? "text-amber-500"
          : "text-muted-foreground/60";
  return (
    <span className={cn("flex items-center gap-1.5", cls)}>
      <span aria-hidden>{glyph}</span>
      <span>{label}</span>
    </span>
  );
}

/**
 * Inline log peek rendered as a small read-only xterm. Reuses the same
 * xterm renderer as the drawer (so ANSI colors and overwrites display
 * correctly) at a fixed ~3-line height with the scrollbar hidden — xterm
 * auto-scrolls to bottom on each new chunk, giving a live "tail -f" view.
 */
function LogPeek({ source }: { source: string }) {
  return (
    <div className="h-20 w-full overflow-hidden rounded-lg border border-border [&_.xterm-viewport::-webkit-scrollbar]:hidden [&_.xterm-viewport]:!overflow-hidden">
      <VmTerminal source={source} className="h-full" />
    </div>
  );
}

function Footer(props: VmStateCardProps) {
  switch (props.kind) {
    case "never-started":
      return (
        <Button onClick={props.onStart} className="mt-2">
          <Play className="size-4" /> Start dev server
        </Button>
      );
    case "starting-now":
      return (
        <div className="mt-2 flex w-full items-center justify-between text-xs text-muted-foreground">
          <span>elapsed {formatElapsed(props.elapsed)}</span>
          <Button variant="ghost" size="sm" onClick={props.onToggleLogs}>
            {props.drawerOpen ? "Hide logs" : "View logs"}
            {props.drawerOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronUp className="size-3.5" />
            )}
          </Button>
        </div>
      );
    case "errored":
      return (
        <div className="mt-2 flex w-full items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>elapsed {formatElapsed(props.elapsed)}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={props.onToggleLogs}>
              {props.drawerOpen ? "Hide logs" : "View logs"}
              {props.drawerOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronUp className="size-3.5" />
              )}
            </Button>
            <Button size="sm" onClick={props.onRetry}>
              <RefreshCw01 className="size-4" /> Retry
            </Button>
          </div>
        </div>
      );
    case "suspended":
      return (
        <Button onClick={props.onResume} className="mt-2">
          <Play className="size-4" /> Resume
        </Button>
      );
  }
}
