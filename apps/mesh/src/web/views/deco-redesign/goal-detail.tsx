// Goal detail — opening a goal shows: the metric it's verified against, the
// autonomy dial + constraints, and the TASKS the goal spawned (the concrete
// work — each a real thread you can open). No "loop" concept is surfaced; the
// goal just spawns tasks and you watch the metric move.
import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle,
  ChevronRight,
  Expand01,
  Eye,
  Loading01,
  X,
  Zap,
} from "@untitledui/icons";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  effectiveState,
  incidentById,
  type AutonomyMode,
  type IncidentState,
  type Severity,
} from "./mock-data";
import { CMS_PROPOSALS } from "./mock-cms";
import {
  GOALS,
  goalById,
  type Goal,
  type GoalMetric,
  type GoalTask,
  type GoalTaskStatus,
} from "./mock-goals";
import { setGoalAutonomy, useGoalAutonomy, useOverrides } from "./mock-store";
import { MetricChart } from "./primitives";

const AUTONOMY_STEPS: { value: AutonomyMode; label: string }[] = [
  { value: "inform", label: "Inform" },
  { value: "propose", label: "Propose" },
  { value: "auto", label: "Auto" },
];

const AUTONOMY_EXPLAINED: Record<AutonomyMode, string> = {
  inform: "Deco works toward this and tells you, but never acts on its own.",
  propose: "Deco drafts each change and waits for your approval.",
  auto: "Deco ships low-risk, reversible changes itself and reports after.",
};

const SEV_DOT: Record<Severity, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-muted-foreground",
};

// Same status-icon vocabulary as the sidebar task rows (lib/task-status.ts).
const TASK_ICON: Record<
  GoalTaskStatus,
  { icon: typeof Loading01; className: string }
> = {
  running: { icon: Loading01, className: "text-blue-500 animate-spin" },
  needs_review: { icon: AlertCircle, className: "text-orange-500" },
  done: { icon: CheckCircle, className: "text-muted-foreground/50" },
  watching: { icon: Eye, className: "text-amber-500" },
};

const FINDING_STATE: Record<IncidentState, { label: string; tone: string }> = {
  needs_review: { label: "Needs review", tone: "text-foreground" },
  in_progress: { label: "Shipping", tone: "text-muted-foreground" },
  resolved: { label: "Done", tone: "text-success" },
  watching: { label: "Watching", tone: "text-muted-foreground" },
  acknowledged: { label: "Acknowledged", tone: "text-muted-foreground" },
  dismissed: { label: "Dismissed", tone: "text-muted-foreground" },
};

/** The autonomy dial — a segmented switch (Inform / Propose / Auto). Controlled;
 *  writes go to the goal-autonomy store so every surface stays in sync. */
export function AutonomyDial({
  value,
  onChange,
  className,
}: {
  value: AutonomyMode;
  onChange: (next: AutonomyMode) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex shrink-0 rounded-lg bg-muted p-0.5",
        className,
      )}
    >
      {AUTONOMY_STEPS.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => onChange(s.value)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            value === s.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** A task's live status: if it's linked to a finding the user has acted on, the
 *  finding-state store wins (approve in the thread → reflected here); otherwise
 *  the task's seeded status. */
function effectiveTaskStatus(
  task: GoalTask,
  findingOverrides: Record<string, IncidentState>,
): GoalTaskStatus {
  const override = task.findingId
    ? findingOverrides[task.findingId]
    : undefined;
  if (!override) return task.status;
  switch (override) {
    case "needs_review":
      return "needs_review";
    case "in_progress":
      return "running";
    case "watching":
      return "watching";
    case "resolved":
    case "acknowledged":
    case "dismissed":
      return "done";
    default: {
      const _exhaustive: never = override;
      return _exhaustive;
    }
  }
}

/** The compact goal card — shared by the home "Your goals" row and the goals
 *  list. Title + primary metric (chart + value + delta). Opens the goal detail. */
export function GoalSummaryCard({
  goal,
  onOpen,
}: {
  goal: Goal;
  onOpen: () => void;
}) {
  const m = goal.metrics[0];
  if (!m) return null;
  const healthy = m.deltaPct >= 0 === m.higherIsBetter;
  const Arrow = m.deltaPct >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring/40"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {goal.title}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {m.label}
          </div>
        </div>
        <ChevronRight
          size={14}
          className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </div>

      <MetricChart
        points={m.spark}
        tone={healthy ? "good" : "bad"}
        id={goal.id}
        className="h-16"
      />

      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap text-xl font-semibold text-foreground">
          {m.value}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 text-xs",
            healthy ? "text-success" : "text-destructive",
          )}
        >
          <Arrow size={12} />
          {m.deltaPct >= 0 ? "+" : ""}
          {m.deltaPct}%
        </span>
      </div>
    </button>
  );
}

/** The goals list — every goal the teammate owns. Reached from the sidebar. */
export function GoalsListView({
  onOpenGoal,
}: {
  onOpenGoal: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-10 py-10">
        <h1 className="text-xl font-medium text-foreground">Goals</h1>
        <div className="grid gap-3 md:grid-cols-2">
          {GOALS.map((g) => (
            <GoalSummaryCard
              key={g.id}
              goal={g}
              onOpen={() => onOpenGoal(g.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function GoalDetailView({
  goalId,
  onBack,
  onOpenFinding,
}: {
  goalId: string;
  onBack: () => void;
  onOpenFinding: (id: string) => void;
}) {
  const autonomyOverrides = useGoalAutonomy();
  const findingOverrides = useOverrides();
  const goal = goalById(goalId);
  if (!goal) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-10 py-10">
          <button
            type="button"
            onClick={onBack}
            className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={14} />
            Back
          </button>
          <p className="text-sm text-muted-foreground">Goal not found.</p>
        </div>
      </div>
    );
  }
  const autonomy = autonomyOverrides[goal.id] ?? goal.autonomy;
  const tasks = goal.tasks.map((t) => ({
    task: t,
    status: effectiveTaskStatus(t, findingOverrides),
  }));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-8 px-10 py-10">
        <div>
          <h1 className="text-xl leading-snug text-foreground">{goal.title}</h1>
          <p className="mt-2 max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
            {goal.summary}
          </p>
        </div>

        <div
          className={cn(
            "grid gap-3",
            goal.metrics.length > 1 && "sm:grid-cols-2",
          )}
        >
          {goal.metrics.map((m, i) => (
            <MetricCard key={m.label} metric={m} id={`${goal.id}-${i}`} />
          ))}
        </div>

        <AutonomyBlock
          key={goal.id}
          value={autonomy}
          onChange={(next) => setGoalAutonomy(goal.id, next)}
          constraints={goal.constraints}
        />

        <FindingsSection
          findingIds={goal.findingIds}
          onOpenFinding={onOpenFinding}
        />

        {/* Tasks the goal spawned — the concrete work, each a real thread.
            Same row-table as the home findings list. */}
        <section>
          <div className="mb-3 text-sm font-medium text-muted-foreground">
            Tasks
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
            {tasks.map(({ task, status }) => (
              <TaskRow
                key={task.id}
                task={task}
                status={status}
                onOpen={
                  task.findingId
                    ? () => onOpenFinding(task.findingId as string)
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ metric, id }: { metric: GoalMetric; id: string }) {
  const m = metric;
  const healthy = m.deltaPct >= 0 === m.higherIsBetter;
  const Arrow = m.deltaPct >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {m.label}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <IntegrationIcon
              icon={m.sourceIcon}
              name={m.source}
              size="2xs"
              fallbackIcon={<Zap size={10} className="text-muted-foreground" />}
            />
            <span className="truncate">{m.source}</span>
          </div>
        </div>
        <Expand01 size={14} className="shrink-0 text-muted-foreground/40" />
      </div>

      <MetricChart
        points={m.spark}
        tone={healthy ? "good" : "bad"}
        id={id}
        className="h-24"
      />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="whitespace-nowrap text-2xl font-semibold text-foreground">
          {m.value}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 text-xs",
            healthy ? "text-success" : "text-destructive",
          )}
        >
          <Arrow size={12} />
          {m.deltaPct >= 0 ? "+" : ""}
          {m.deltaPct}%
        </span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          target {m.target}
        </span>
      </div>
    </div>
  );
}

function AutonomyBlock({
  value,
  onChange,
  constraints,
}: {
  value: AutonomyMode;
  onChange: (next: AutonomyMode) => void;
  constraints: string[];
}) {
  return (
    <section className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Autonomy</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {AUTONOMY_EXPLAINED[value]}
          </p>
        </div>
        <AutonomyDial value={value} onChange={onChange} />
      </div>

      <div className="border-t border-border pt-4">
        <div className="text-sm font-medium text-foreground">Constraints</div>
        <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
          Rules I'll never break while working on this goal. On Auto, anything
          that would break one comes to you instead.
        </p>
        <ConstraintsEditor initial={constraints} />
      </div>
    </section>
  );
}

/** Editable constraint tags — remove with ×, add by typing + Enter. Local to
 *  the mock; the real product would persist these to the goal's memory. */
function ConstraintsEditor({ initial }: { initial: string[] }) {
  const [rules, setRules] = useState(initial);
  const [draft, setDraft] = useState("");

  const add = () => {
    const t = draft.trim();
    if (t && !rules.includes(t)) setRules([...rules, t]);
    setDraft("");
  };
  const remove = (c: string) => setRules(rules.filter((r) => r !== c));

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-2 py-2">
      {rules.map((c) => (
        <span
          key={c}
          className="inline-flex items-center gap-1 rounded-full bg-muted py-1 pl-2.5 pr-1.5 text-xs text-foreground"
        >
          {c}
          <button
            type="button"
            onClick={() => remove(c)}
            aria-label={`Remove ${c}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && rules.length > 0) {
            setRules(rules.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder="Add a constraint…"
        className="min-w-[140px] flex-1 bg-transparent py-0.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function TaskRow({
  task,
  status,
  onOpen,
}: {
  task: GoalTask;
  status: GoalTaskStatus;
  onOpen?: () => void;
}) {
  const { icon: Icon, className: iconClass } = TASK_ICON[status];
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left",
        onOpen ? "hover:bg-accent/40" : "cursor-default",
      )}
    >
      <Icon size={14} className={cn("shrink-0", iconClass)} />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {task.title}
      </span>
    </button>
  );
}

interface FindingRow {
  id: string;
  title: string;
  severity: Severity;
  state: IncidentState;
}

/** The findings Deco detected under this goal — the observations (from System
 *  Health + content), distinct from the tasks (the work). Same row-table look. */
function FindingsSection({
  findingIds,
  onOpenFinding,
}: {
  findingIds: string[];
  onOpenFinding: (id: string) => void;
}) {
  const overrides = useOverrides();
  const rows = findingIds
    .map((id): FindingRow | null => {
      const inc = incidentById(id);
      if (inc) {
        return {
          id,
          title: inc.title,
          severity: inc.severity,
          state: effectiveState(inc, overrides),
        };
      }
      const cms = CMS_PROPOSALS.find((p) => p.id === id);
      if (cms) {
        return {
          id,
          title: cms.title,
          severity: "info",
          state: effectiveState(cms, overrides),
        };
      }
      return null;
    })
    .filter((r): r is FindingRow => r !== null);

  if (rows.length === 0) return null;
  return (
    <section>
      <div className="mb-3 text-sm font-medium text-muted-foreground">
        Findings
      </div>
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenFinding(r.id)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent/40"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                SEV_DOT[r.severity],
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {r.title}
            </span>
            <span
              className={cn("shrink-0 text-xs", FINDING_STATE[r.state].tone)}
            >
              {FINDING_STATE[r.state].label}
            </span>
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          </button>
        ))}
      </div>
    </section>
  );
}
