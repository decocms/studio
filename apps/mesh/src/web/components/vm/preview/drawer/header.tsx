import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ChevronDown,
  ChevronUp,
  Play,
  RefreshCw01,
  StopCircle,
} from "@untitledui/icons";
import type { PhaseKey, PhaseProgress } from "../derive-phase-progress";
import { phaseStatusFor, phaseTickGlyph } from "../state-card-helpers";
import { type DrawerStatus, statusPillFor } from "./status-pill";

export type { DrawerStatus } from "./status-pill";
export type { PhaseKey } from "../derive-phase-progress";

export interface DrawerHeaderProps {
  status: DrawerStatus;
  open: boolean;
  progress: PhaseProgress;
  onToggle: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  onResume?: () => void;
  onPhaseClick: (key: PhaseKey) => void;
}

export function DrawerHeader(props: DrawerHeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-muted/30 px-3">
      <StatusPill status={props.status} />
      <button
        type="button"
        aria-label="Toggle drawer"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={props.onToggle}
      >
        {props.open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronUp className="size-3.5" />
        )}
        logs
      </button>
      <div className="mx-2 h-4 w-px bg-border" />
      <PhaseTicks progress={props.progress} onClick={props.onPhaseClick} />
      <div className="ml-auto flex items-center gap-1">
        {props.status === "idle" && props.onStart && (
          <Button size="sm" variant="ghost" onClick={props.onStart}>
            <Play className="size-3.5" /> Start
          </Button>
        )}
        {props.status === "suspended" && props.onResume && (
          <Button size="sm" variant="ghost" onClick={props.onResume}>
            <Play className="size-3.5" /> Resume
          </Button>
        )}
        {(props.status === "running" || props.status === "starting") &&
          props.onStop && (
            <Button size="sm" variant="ghost" onClick={props.onStop}>
              <StopCircle className="size-3.5" /> Stop
            </Button>
          )}
        {props.status === "running" && props.onRestart && (
          <Button size="sm" variant="ghost" onClick={props.onRestart}>
            <RefreshCw01 className="size-3.5" /> Restart
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: DrawerStatus }) {
  const { className, label } = statusPillFor(status);
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        className,
      )}
    >
      ● {label}
    </span>
  );
}

function PhaseTicks({
  progress,
  onClick,
}: {
  progress: PhaseProgress;
  onClick: (k: PhaseKey) => void;
}) {
  const items: PhaseKey[] = ["provision", "cloning", "install", "dev"];
  return (
    <div className="flex items-center gap-3 text-xs">
      {items.map((k) => {
        const s = phaseStatusFor(progress, k);
        return (
          <button
            key={k}
            type="button"
            disabled={k === "provision"}
            onClick={() => onClick(k)}
            className={cn(
              "flex items-center gap-1",
              k === "provision" && "cursor-default",
              s === "done" && "text-emerald-600",
              s === "failed" && "text-destructive",
              s === "doing" && "text-amber-500",
              s === "pending" && "text-muted-foreground/60",
            )}
            title={
              k === "provision" && s !== "done"
                ? "Waiting for sandbox — no logs yet"
                : undefined
            }
          >
            {phaseTickGlyph(s)} {k}
          </button>
        );
      })}
    </div>
  );
}
