import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertTriangle,
  Code02,
  Monitor04,
  PauseCircle,
  Play,
  RefreshCw01,
  Terminal,
} from "@untitledui/icons";
import { BootingVisual } from "./booting-visual";
import { SandboxTerminal } from "./drawer/terminal";
import type { ClaimPhase } from "../hooks/sandbox-events-context";
import type { PhaseProgress, PhaseStatus } from "./derive-phase-progress";
import {
  headlineFor,
  phaseStatusFor,
  phaseTickGlyph,
} from "./state-card-helpers";
import type { StateCardKind } from "./state-card-types";

export type SandboxStateCardProps =
  | { kind: "never-started"; onStart: () => void }
  | {
      kind: "starting-now";
      progress: PhaseProgress;
      claimPhase: ClaimPhase | null;
    }
  | {
      kind: "errored";
      progress: PhaseProgress;
      logSource: string;
      errorLine: string;
      onRetry: () => void;
      /** Drawer-open hides the inline peek (mutually exclusive surfaces). */
      drawerOpen: boolean;
    }
  | {
      kind: "dev-script-failed";
      progress: PhaseProgress;
      logSource: string;
      errorLine: string;
      onRetry: () => void;
      onOpenTerminal: () => void;
      onBrowseFiles: () => void;
      /** Drawer-open hides the inline peek (mutually exclusive surfaces). */
      drawerOpen: boolean;
    }
  | { kind: "suspended"; onResume: () => void }
  | { kind: "crashed"; onOpenTerminal: () => void };

export function SandboxStateCard(props: SandboxStateCardProps) {
  if (props.kind === "starting-now") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <BootingVisual
          progress={props.progress}
          claimPhase={props.claimPhase}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <Glyph kind={props.kind} />
        <Headline kind={props.kind} />
        <Subline {...props} />
        {(props.kind === "errored" || props.kind === "dev-script-failed") && (
          <PhaseStripView progress={props.progress} />
        )}
        {(props.kind === "errored" || props.kind === "dev-script-failed") &&
          !props.drawerOpen && <LogPeek source={props.logSource} />}
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
    case "dev-script-failed":
      return <AlertTriangle className={cn(cls, "text-destructive")} />;
    case "suspended":
      return <PauseCircle className={cn(cls, "text-blue-500")} />;
    case "crashed":
      return <AlertTriangle className={cn(cls, "text-amber-500")} />;
  }
}

function Headline({ kind }: { kind: NonBootingKind }) {
  return <h3 className="text-lg font-medium">{headlineFor(kind)}</h3>;
}

function Subline(
  props: Exclude<SandboxStateCardProps, { kind: "starting-now" }>,
) {
  switch (props.kind) {
    case "never-started":
      return (
        <p className="max-w-sm text-sm text-muted-foreground">
          Start the sandbox to launch your dev environment.
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
    case "dev-script-failed":
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
    case "crashed":
      return (
        <p className="max-w-sm text-sm text-muted-foreground">
          The dev server stopped responding. Open the terminal to inspect the
          logs and restart it.
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
 * Inline log peek: a small read-only xterm tail of the active log source.
 * Reuses the same xterm renderer as the drawer (so ANSI colors and
 * overwrites display correctly) at a fixed ~5-line height with the
 * scrollbar hidden — xterm auto-scrolls to bottom on each new chunk,
 * giving a live "tail -f" view. The drawer toolbar owns the
 * drawer-toggle affordance, so no expand button lives here.
 */
function LogPeek({ source }: { source: string }) {
  return (
    <div className="flex w-[min(78%,560px)] flex-col items-stretch gap-1.5">
      <div className="h-32 overflow-hidden rounded-md [&_.xterm-viewport::-webkit-scrollbar]:hidden [&_.xterm-viewport]:!overflow-hidden">
        <SandboxTerminal source={source} className="h-full" />
      </div>
    </div>
  );
}

function Footer(
  props: Exclude<SandboxStateCardProps, { kind: "starting-now" }>,
) {
  switch (props.kind) {
    case "never-started":
      return (
        <Button onClick={props.onStart} className="mt-2">
          <Play className="size-4" /> Start sandbox
        </Button>
      );
    case "errored":
      return (
        <Button size="sm" onClick={props.onRetry} className="mt-2">
          <RefreshCw01 className="size-4" /> Retry
        </Button>
      );
    case "dev-script-failed":
      return (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={props.onRetry}>
            <RefreshCw01 className="size-4" /> Retry
          </Button>
          <Button size="sm" variant="outline" onClick={props.onBrowseFiles}>
            <Code02 className="size-4" /> Browse files
          </Button>
          <Button size="sm" variant="outline" onClick={props.onOpenTerminal}>
            <Terminal className="size-4" /> View logs
          </Button>
        </div>
      );
    case "suspended":
      return (
        <Button onClick={props.onResume} className="mt-2">
          <Play className="size-4" /> Resume
        </Button>
      );
    case "crashed":
      return (
        <Button onClick={props.onOpenTerminal} className="mt-2">
          <Terminal className="size-4" /> Open terminal
        </Button>
      );
  }
}
