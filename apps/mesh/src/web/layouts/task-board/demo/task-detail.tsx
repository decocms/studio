/**
 * Linear-like task detail dialog for the demo board: meta row, title,
 * description, mock pull request card and agent session timelines.
 */

import { useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Check,
  ChevronRight,
  Clock,
  DotsHorizontal,
  Flag01,
  User01,
} from "@untitledui/icons";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { PRIORITY_CONFIG, STATUS_CONFIG } from "../config";
import { CmsEditorDialog } from "./cms-editor";
import { type DemoSession, type DemoTask, SOURCE_LABEL } from "./data";
import { DecoAvatar, SourceIcon } from "./icons";

export function TaskDetailDialog({
  task,
  open,
  onClose,
}: {
  task: DemoTask;
  open: boolean;
  onClose: () => void;
}) {
  const [cmsOpen, setCmsOpen] = useState(false);
  const statusConfig = STATUS_CONFIG[task.status];
  const StatusIcon = statusConfig.icon;
  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const takenByAgent =
    task.status === "in_progress" ||
    task.status === "in_review" ||
    task.status === "done";

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="flex max-h-[85vh] flex-row gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogTitle className="sr-only">{task.title}</DialogTitle>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
            <span className="text-xs font-medium text-muted-foreground">
              {task.key}
            </span>

            <h2 className="text-xl font-semibold text-foreground">
              {task.title}
            </h2>

            <p className="text-sm leading-relaxed text-muted-foreground">
              {task.description}
            </p>

            {((task.pr && task.prStatus) ||
              (takenByAgent && task.sessions && task.sessions.length > 0)) && (
              <div className="flex flex-col gap-3 border-t border-border pt-5">
                <h3 className="text-sm font-semibold text-foreground">
                  Activity
                </h3>
                {task.pr && task.prStatus && (
                  <PrCard task={task} onEdit={() => setCmsOpen(true)} />
                )}
                {takenByAgent &&
                  task.sessions?.map((s, i) => (
                    <SessionCard
                      key={s.startedAgo + i}
                      session={s}
                      task={task}
                    />
                  ))}
              </div>
            )}
          </div>

          <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-5 py-6">
            <h3 className="text-xs font-medium text-muted-foreground">
              Properties
            </h3>
            <PropertyRow
              icon={
                <StatusIcon size={15} className={statusConfig.iconClassName} />
              }
            >
              {statusConfig.label}
            </PropertyRow>
            <PropertyRow
              icon={
                <Flag01 size={15} className={priorityConfig.flagClassName} />
              }
            >
              {priorityConfig.label}
            </PropertyRow>
            <PropertyRow
              icon={
                takenByAgent ? (
                  <DecoAvatar />
                ) : (
                  <User01 size={15} className="text-muted-foreground" />
                )
              }
            >
              {takenByAgent ? "Deco" : "Unassigned"}
            </PropertyRow>
            <PropertyRow icon={<SourceIcon source={task.source} size={15} />}>
              {SOURCE_LABEL[task.source]}
            </PropertyRow>
            <PropertyRow
              icon={<Clock size={15} className="text-muted-foreground" />}
            >
              Est. {task.effort}
            </PropertyRow>
            {task.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((label) => (
                  <Badge
                    key={label}
                    className="bg-muted text-[10px] text-muted-foreground"
                  >
                    {label}
                  </Badge>
                ))}
              </div>
            )}
          </aside>
        </DialogContent>
      </Dialog>

      {task.cms && (
        <CmsEditorDialog
          task={task}
          open={cmsOpen}
          onClose={() => setCmsOpen(false)}
        />
      )}
    </>
  );
}

function PropertyRow({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-foreground">
      <span className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function PrCard({ task, onEdit }: { task: DemoTask; onEdit: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const pr = task.pr;
  if (!pr) return null;
  const merged = task.prStatus === "merged";

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full flex-col gap-2 px-4 py-3 text-left"
      >
        <div className="flex w-full items-center gap-2">
          <GitHubIcon size={16} className="shrink-0 text-foreground" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {pr.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            #{pr.number}
          </span>
          <span className="flex-1" />
          <Badge
            className={cn(
              "shrink-0 text-[10px]",
              merged
                ? "bg-purple-500/10 text-purple-600"
                : "bg-green-500/10 text-green-600",
            )}
          >
            {merged ? "Merged" : "Open"}
          </Badge>
        </div>

        <div
          className={cn(
            "relative overflow-hidden",
            !expanded && "max-h-[2.5rem]",
          )}
        >
          <p className="text-xs leading-relaxed text-muted-foreground">
            {pr.summary.join(". ")}.
          </p>
          {!expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="flex items-center gap-2 px-4 pb-3">
          <Button variant="outline" size="sm" asChild>
            <a href="#" onClick={(e) => e.preventDefault()}>
              <GitHubIcon size={14} />
              View on GitHub
            </a>
          </Button>
          {task.cms && (
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
          {task.published && (
            <span className="inline-flex items-center gap-1 text-xs text-green-600">
              <Check size={12} />
              Published via CMS
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function sessionStatus(
  task: DemoTask,
  session: DemoSession,
): { text: string; tone: "working" | "done" } | null {
  const prNumber = task.pr?.number;
  switch (task.status) {
    case "in_progress":
      return { text: `Working: ${session.workingStatus}`, tone: "working" };
    case "in_review":
      return {
        text: `Opened PR #${prNumber}, waiting for review`,
        tone: "done",
      };
    case "done":
      return { text: `PR #${prNumber} merged`, tone: "done" };
    case "triage":
    case "todo":
      return null;
    default: {
      const exhaustive: never = task.status;
      return exhaustive;
    }
  }
}

function SessionCard({
  session,
  task,
}: {
  session: DemoSession;
  task: DemoTask;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = sessionStatus(task, session);
  const working = task.status === "in_progress";
  // While working the timeline hasn't reached the PR step yet.
  const steps = working ? session.steps.slice(0, -1) : session.steps;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <DecoAvatar className="size-5 text-[10px]" />
        <span className="text-sm font-medium text-foreground">Deco</span>
        <span className="text-xs text-muted-foreground">
          started by {session.startedBy}
        </span>
        <span className="text-xs text-muted-foreground/70">
          {session.startedAgo}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Session options"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <DotsHorizontal size={14} />
        </button>
      </div>

      <div className="border-t border-border" />

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
      >
        {status && (
          <>
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                status.tone === "working"
                  ? "animate-pulse bg-blue-500"
                  : "bg-green-500",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {status.text}
            </span>
          </>
        )}
        <span className="flex-1" />
        <ChevronRight
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {steps.map((step, i) => {
            const last = i === steps.length - 1;
            return (
              <div
                key={step.text}
                className={cn(
                  "flex items-center gap-2.5 text-xs",
                  last ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Check
                  size={12}
                  className={cn(
                    "shrink-0",
                    last ? "text-green-500" : "text-muted-foreground/50",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{step.text}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                  {step.time}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
