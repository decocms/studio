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
  ChevronDown,
  ChevronRight,
  DotsHorizontal,
  Flag01,
  GitBranch01,
  User01,
} from "@untitledui/icons";
import { PRIORITY_CONFIG, STATUS_CONFIG } from "../config";
import { CmsEditorDialog } from "./cms-editor";
import { type DemoSession, type DemoTask, SOURCE_LABEL } from "./data";
import { DecoAvatar, SourceIcon } from "./icons";

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground";

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
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogTitle className="sr-only">{task.title}</DialogTitle>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {task.key}
              </span>
              <span className={CHIP_CLASS}>
                <StatusIcon size={13} className={statusConfig.iconClassName} />
                {statusConfig.label}
              </span>
              <span className={CHIP_CLASS}>
                <Flag01 size={13} className={priorityConfig.flagClassName} />
                {priorityConfig.label}
              </span>
              <span className={CHIP_CLASS}>
                <SourceIcon source={task.source} size={13} />
                {SOURCE_LABEL[task.source]}
              </span>
              <span className={CHIP_CLASS}>
                {takenByAgent ? (
                  <>
                    <DecoAvatar />
                    Deco
                  </>
                ) : (
                  <>
                    <User01 size={13} className="text-muted-foreground" />
                    Unassigned
                  </>
                )}
              </span>
              {task.labels.map((label) => (
                <Badge
                  key={label}
                  className="bg-muted text-[10px] text-muted-foreground"
                >
                  {label}
                </Badge>
              ))}
              <span className="text-[11px] text-muted-foreground/70">
                Est. {task.effort}
              </span>
            </div>

            <h2 className="text-xl font-semibold text-foreground">
              {task.title}
            </h2>

            <p className="text-sm leading-relaxed text-muted-foreground">
              {task.description}
            </p>

            {task.pr && task.prStatus && (
              <PrCard task={task} onEdit={() => setCmsOpen(true)} />
            )}

            {takenByAgent && task.sessions && task.sessions.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Agent sessions
                </h3>
                {task.sessions.map((s, i) => (
                  <SessionCard key={s.startedAgo + i} session={s} task={task} />
                ))}
              </div>
            )}
          </div>
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

function PrCard({ task, onEdit }: { task: DemoTask; onEdit: () => void }) {
  const [filesOpen, setFilesOpen] = useState(false);
  const pr = task.pr;
  if (!pr) return null;
  const merged = task.prStatus === "merged";

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">
        Pull request
      </h3>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <GitBranch01 size={14} className="shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {pr.title}
          </span>
          <span className="text-xs text-muted-foreground">#{pr.number}</span>
          <Badge
            className={cn(
              "text-[10px]",
              merged
                ? "bg-purple-500/10 text-purple-600"
                : "bg-green-500/10 text-green-600",
            )}
          >
            {merged ? "Merged" : "Open"}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {pr.branch}
          </span>
          <span className="font-medium text-green-600">+{pr.additions}</span>
          <span className="font-medium text-red-600">-{pr.deletions}</span>
          {task.published && (
            <span className="inline-flex items-center gap-1 text-green-600">
              <Check size={12} />
              Published via CMS
            </span>
          )}
        </div>

        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
          {pr.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => setFilesOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {filesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Files changed ({pr.files.length})
        </button>

        {filesOpen && (
          <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3">
            {pr.files.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 font-mono text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {file.path}
                </span>
                <span className="text-green-600">+{file.additions}</span>
                <span className="text-red-600">-{file.deletions}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href="#" onClick={(e) => e.preventDefault()}>
              View on GitHub
            </a>
          </Button>
          {task.cms && (
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
        </div>
      </div>
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
