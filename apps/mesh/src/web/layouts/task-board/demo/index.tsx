/**
 * Fully mocked, scripted demo task board for live product critique demos.
 * Rendered in place of the real board inside the same shell. All behavior
 * is driven by the external demo store (./store): nothing runs on mount,
 * everything starts from user clicks.
 */

import { useState, useSyncExternalStore } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Check,
  Flag01,
  GitBranch01,
  Loading01,
  Stars01,
} from "@untitledui/icons";
import {
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  STATUSES,
  type TaskBoardItemStatus,
} from "../config";
import type { DemoTask } from "./data";
import { DecoAvatar, SourceIcon } from "./icons";
import {
  type DemoPhase,
  type DemoState,
  generateBacklog,
  getSnapshot,
  moveTask,
  reset,
  subscribe,
  toggleAutoMerge,
} from "./store";
import { TaskDetailDialog } from "./task-detail";

function useDemoStore(): DemoState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function statusLine(phase: DemoPhase, workingCount: number): string | null {
  switch (phase) {
    case "idle":
      return null;
    case "generating":
      return "Analyzing GA4, Search Console and GitHub signals";
    case "running":
      return workingCount > 0
        ? `Deco is working on ${workingCount} ${workingCount === 1 ? "task" : "tasks"}`
        : "Deco is picking up the next tasks";
    case "done":
      return "Deco finished this run: PRs are ready for review";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

export default function DemoTaskBoard() {
  const state = useDemoStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const workingCount = state.tasks.filter(
    (t) => t.status === "in_progress",
  ).length;
  const line = statusLine(state.phase, workingCount);
  const selected = state.tasks.find((t) => t.id === selectedId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-10 pt-10 pb-16">
        <h1 className="text-xl font-medium text-foreground">Tasks</h1>

        <div className="flex flex-wrap items-center gap-3">
          {state.phase === "idle" ? (
            <Button size="sm" onClick={() => void generateBacklog()}>
              <Stars01 size={16} />
              Generate backlog
            </Button>
          ) : state.phase === "generating" ? (
            <Button size="sm" disabled>
              <Loading01 size={16} className="animate-spin" />
              Generating backlog...
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              <Check size={16} className="text-green-600" />
              Backlog generated
            </Button>
          )}

          {line && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {state.phase !== "done" && (
                <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
              )}
              {line}
            </span>
          )}

          {state.phase !== "idle" && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={reset}
            >
              Reset
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <label
                  htmlFor="demo-auto-merge"
                  className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
                >
                  Auto merge
                  <Switch
                    id="demo-auto-merge"
                    checked={state.autoMerge}
                    onCheckedChange={toggleAutoMerge}
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent>Merge approved PRs automatically</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {state.tasks.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
            Connect your sources and generate a backlog to get started.
          </div>
        ) : (
          <Lanes tasks={state.tasks} onOpen={(t) => setSelectedId(t.id)} />
        )}
      </div>

      {selected && (
        <TaskDetailDialog
          key={selected.id}
          task={selected}
          open
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function Lanes({
  tasks,
  onOpen,
}: {
  tasks: DemoTask[];
  onOpen: (task: DemoTask) => void;
}) {
  const [overLane, setOverLane] = useState<TaskBoardItemStatus | null>(null);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {STATUSES.map((status) => {
        const laneTasks = tasks.filter((t) => t.status === status);
        const config = STATUS_CONFIG[status];
        const LaneIcon = config.icon;
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              setOverLane(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setOverLane(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              if (id) moveTask(id, status);
              setOverLane(null);
            }}
            className={cn(
              "flex flex-col rounded-xl p-1 transition-colors",
              overLane === status && "bg-muted/50",
            )}
          >
            <div className="flex items-center gap-2 p-2">
              <LaneIcon
                size={14}
                className={cn("shrink-0", config.iconClassName)}
              />
              <span className="text-xs text-foreground">{config.label}</span>
              <span className="text-[11px] text-muted-foreground">
                {laneTasks.length}
              </span>
            </div>
            <div className="flex min-h-12 flex-col gap-2">
              {laneTasks.map((task) => (
                <DemoTaskCard
                  key={task.id}
                  task={task}
                  onOpen={() => onOpen(task)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DemoTaskCard({
  task,
  onOpen,
}: {
  task: DemoTask;
  onOpen: () => void;
}) {
  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const done = task.status === "done";

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className={cn(
        "flex cursor-grab flex-col gap-2 rounded-[10px] border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-ring/40 active:cursor-grabbing",
        "animate-in fade-in slide-in-from-bottom-1 duration-300",
        done && "opacity-60",
      )}
    >
      <span className="text-[10px] text-muted-foreground/70">{task.key}</span>
      <span
        className={cn(
          "min-w-0 text-[13px] font-medium leading-snug text-foreground",
          done && "text-muted-foreground",
        )}
      >
        {task.title}
      </span>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <SourceIcon source={task.source} size={12} />
        <Flag01 size={12} className={priorityConfig.flagClassName} />

        {task.status === "in_progress" && (
          <span className="inline-flex items-center gap-1.5 text-blue-600">
            <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
            <DecoAvatar className="animate-pulse" />
            Deco
          </span>
        )}

        {task.status === "in_review" && task.pr && (
          <span className="inline-flex items-center gap-1 rounded-md bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-600">
            <GitBranch01 size={10} />#{task.pr.number}
          </span>
        )}

        {done && (
          <span className="inline-flex items-center gap-1 text-green-600">
            <Check size={12} />
            {task.pr ? `#${task.pr.number} merged` : "Done"}
          </span>
        )}
      </div>
    </button>
  );
}
