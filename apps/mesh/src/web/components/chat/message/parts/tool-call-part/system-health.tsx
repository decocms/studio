// System Health tool UIs — rendered inside the chat exactly like any other tool
// call (e.g. brand context). Two tools:
//   tool-system_health_spike → the error/metric spike graph
//   tool-system_health_fix   → the proposed fix (PR + checks) + approve actions
// They read their data from `part.output` (mock today; a real System Health tool
// would emit the same shape). The fix part writes to the redesign mock-store so
// the home + sidebar reflect an approval/dismissal.
import { useState } from "react";
import type { ToolUIPart } from "ai";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Check,
  CheckCircle,
  ChevronDown,
  Loading01,
  RefreshCw01,
  Tool01,
  XCircle,
} from "@untitledui/icons";
import { SpikeGraph } from "@/web/views/deco-redesign/primitives";
import {
  setIncidentState,
  useOverrides,
} from "@/web/views/deco-redesign/mock-store";
import type { IncidentState } from "@/web/views/deco-redesign/mock-data";
import { unwrapResult } from "./utils.tsx";

interface SpikeOutput {
  label: string;
  points: number[];
  baseline: number;
  tone: "destructive" | "warning" | "primary" | "muted";
}

export function SystemHealthSpikePart({ part }: { part: ToolUIPart }) {
  const data = unwrapResult<SpikeOutput>(part.output);
  if (!data) return null;
  return (
    <div className="my-3 max-w-[600px] rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{data.label} · last 2h</span>
        <span>baseline ~{data.baseline.toLocaleString()}</span>
      </div>
      <SpikeGraph
        points={data.points}
        baseline={data.baseline}
        tone={data.tone}
      />
    </div>
  );
}

interface FixOutput {
  incidentId: string;
  seedState: IncidentState;
  pr: number;
  title: string;
  summary: string;
  diff: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  qa: "passed" | "running" | "failed";
  aiReview: "passed" | "flagged";
  autonomy: "inform" | "propose" | "auto";
}

type Outcome = "approved" | "handed" | "dismissed" | "undone" | null;

export function SystemHealthFixPart({ part }: { part: ToolUIPart }) {
  const fix = unwrapResult<FixOutput>(part.output);
  const overrides = useOverrides();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [showDiff, setShowDiff] = useState(false);
  if (!fix) return null;

  const base = overrides[fix.incidentId] ?? fix.seedState;
  const published = base === "resolved";
  const qaRunning = fix.qa === "running";

  const act = (next: Outcome, state: IncidentState) => {
    setOutcome(next);
    setIncidentState(fix.incidentId, state);
  };

  return (
    <div className="my-3 flex max-w-[600px] flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {/* What: the change, in plain language. */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Tool01 size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {fix.title}
          </span>
          {published ? (
            <span className="ml-auto shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
              Published
            </span>
          ) : (
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              Change #{fix.pr}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-sm text-muted-foreground">{fix.summary}</p>

          {/* Trust: the checks that justify shipping, scannable up front. */}
          <div className="flex flex-wrap gap-2">
            <Signal
              icon={
                fix.qa === "passed"
                  ? CheckCircle
                  : fix.qa === "failed"
                    ? XCircle
                    : Loading01
              }
              tone={
                fix.qa === "passed"
                  ? "success"
                  : fix.qa === "failed"
                    ? "destructive"
                    : "warning"
              }
              spin={qaRunning}
              label={
                fix.qa === "passed"
                  ? "QA passed"
                  : fix.qa === "failed"
                    ? "QA failed"
                    : "QA running"
              }
            />
            <Signal
              icon={fix.aiReview === "passed" ? CheckCircle : XCircle}
              tone={fix.aiReview === "passed" ? "success" : "warning"}
              label={
                fix.aiReview === "passed"
                  ? "AI review passed"
                  : "AI review flagged"
              }
            />
            <Signal
              icon={RefreshCw01}
              tone="muted"
              label="Reverts in one click"
            />
          </div>

          {/* Detail: the diff, collapsed by default so it doesn't dominate. */}
          <div className="overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className="flex w-full items-center gap-2 bg-muted px-3 py-2 text-xs hover:text-foreground"
            >
              <ChevronDown
                size={13}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform",
                  !showDiff && "-rotate-90",
                )}
              />
              <span className="font-medium text-foreground">View change</span>
              <span className="ml-auto flex items-center gap-2 text-muted-foreground">
                <span>{fix.filesChanged} files</span>
                <span className="text-success">+{fix.additions}</span>
                <span className="text-destructive">−{fix.deletions}</span>
              </span>
            </button>
            {showDiff && (
              <pre className="overflow-x-auto bg-card p-3 text-xs leading-relaxed text-foreground">
                <code>{fix.diff}</code>
              </pre>
            )}
          </div>
        </div>
      </div>

      {/* Decide. */}
      {outcome === null ? (
        <FixActions base={base} qaRunning={qaRunning} onAct={act} />
      ) : (
        <p className="text-sm text-foreground">{followupText(outcome)}</p>
      )}
    </div>
  );
}

function Signal({
  icon: Icon,
  label,
  tone,
  spin = false,
}: {
  icon: typeof CheckCircle;
  label: string;
  tone: "success" | "warning" | "destructive" | "muted";
  spin?: boolean;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "destructive"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground">
      <Icon
        size={13}
        className={cn("shrink-0", toneClass, spin && "animate-spin")}
      />
      {label}
    </span>
  );
}

function FixActions({
  base,
  qaRunning,
  onAct,
}: {
  base: IncidentState;
  qaRunning: boolean;
  onAct: (outcome: Outcome, state: IncidentState) => void;
}) {
  if (base === "needs_review") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="success"
            onClick={() => onAct("approved", "in_progress")}
          >
            <Check size={14} />
            {qaRunning ? "Approve & publish when ready" : "Approve & publish"}
          </Button>
          <Button
            variant="outline"
            onClick={() => onAct("handed", "in_progress")}
          >
            Hand to a developer
          </Button>
          <Button
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={() => onAct("dismissed", "dismissed")}
          >
            Not a real issue
          </Button>
        </div>
        {qaRunning && (
          <p className="text-xs text-muted-foreground">
            QA is still running — I'll publish automatically once it passes.
          </p>
        )}
      </div>
    );
  }
  if (base === "resolved") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => onAct("undone", "watching")}>
          Undo this change
        </Button>
      </div>
    );
  }
  return null;
}

function followupText(outcome: Exclude<Outcome, null>): string {
  switch (outcome) {
    case "approved":
      return "Approved — publishing the fix now. I'll watch the error rate for the next hour and tell you if it doesn't settle.";
    case "handed":
      return "Handed to a developer with the diagnosis and the change linked. I'll track it and update this task when it moves.";
    case "dismissed":
      return "Got it — not a real issue. I'll raise the bar for this pattern so it won't page you again, and note it in memory.";
    case "undone":
      return "Reverted the change. The store is back to the previous state — nothing else changed.";
  }
}
