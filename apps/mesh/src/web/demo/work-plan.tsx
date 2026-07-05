/**
 * Demo Mode — inline work-plan (sprint) + pull-request cards.
 *
 * Rendered INLINE in the chat flow (registered via the part-renderer registry,
 * see register-parts.tsx) from the message part's `output`. Pure + data-driven:
 * the Director mutates the part output to tick tasks / approve / merge. Buttons
 * carry `data-demo-target` so the ghost cursor can aim at them; they're visual
 * only (the Director performs the action).
 */
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ArrowRight,
  Bell01,
  Check,
  GitBranch01,
  GitPullRequest,
  Target04,
} from "@untitledui/icons";
import type {
  DigestState,
  PlanState,
  PlanTaskStatus,
  PRState,
} from "./director-stores";

function TaskIcon({ status }: { status: PlanTaskStatus }) {
  if (status === "done") {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3" />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-foreground" />
    );
  }
  return (
    <span className="size-5 rounded-full border-2 border-dashed border-muted-foreground/30" />
  );
}

function StatusLabel({ status }: { status: PlanTaskStatus }) {
  const map = {
    done: { text: "Done", cls: "text-primary" },
    active: { text: "In progress", cls: "text-foreground" },
    queued: { text: "Queued", cls: "text-muted-foreground" },
  } as const;
  const { text, cls } = map[status];
  return <span className={cn("text-[11px] font-medium", cls)}>{text}</span>;
}

export function WorkPlanCard({ plan }: { plan: PlanState }) {
  const done = plan.tasks.filter((t) => t.status === "done").length;
  return (
    <div className="my-2 w-full animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border border-border bg-card duration-500">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Target04 className="size-4" />
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-foreground">
            {plan.title}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {plan.tasks.length} tasks ·{" "}
            {plan.accepted
              ? `${done}/${plan.tasks.length} done`
              : "needs your approval"}
          </span>
        </div>
        <span
          className={cn(
            "ml-auto rounded-full px-2.5 py-1 text-[11px] font-medium",
            plan.accepted
              ? "bg-primary/10 text-primary"
              : "bg-amber-500/10 text-amber-600",
          )}
        >
          {plan.accepted ? "Approved" : "Review"}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-3">
        {plan.tasks.map((t, i) => (
          <div
            key={i}
            className={cn(
              "flex items-center gap-3 rounded-xl border p-3 transition-colors duration-300",
              t.status === "active"
                ? "border-foreground/20 bg-muted/40"
                : "border-border bg-background",
            )}
          >
            <TaskIcon status={t.status} />
            <div className="flex min-w-0 flex-col leading-tight">
              <span
                className={cn(
                  "text-[13px] font-medium",
                  t.status === "done"
                    ? "text-muted-foreground"
                    : "text-foreground",
                )}
              >
                {t.title}
              </span>
              {t.detail && (
                <span className="text-[11px] text-muted-foreground">
                  {t.detail}
                </span>
              )}
            </div>
            <span className="ml-auto shrink-0">
              <StatusLabel status={t.status} />
            </span>
          </div>
        ))}
      </div>

      {!plan.accepted && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button
            type="button"
            size="sm"
            data-demo-target="approve-plan"
            className="gap-1.5"
          >
            <Check className="size-3.5" />
            Approve &amp; start
          </Button>
          <Button type="button" size="sm" variant="ghost">
            Edit plan
          </Button>
        </div>
      )}
    </div>
  );
}

function ChannelButton({
  target,
  glyph,
  color,
  label,
}: {
  target: string;
  glyph: string;
  color: string;
  label: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-demo-target={target}
      className="gap-2"
    >
      <span
        className="flex size-4 items-center justify-center rounded text-[10px] font-bold"
        style={{ background: color, color: "#fff" }}
      >
        {glyph}
      </span>
      {label}
    </Button>
  );
}

export function DailyDigestCard({ digest }: { digest: DigestState }) {
  const connected = digest.connected;
  return (
    <div className="my-2 w-full animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border border-border bg-card duration-500">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bell01 className="size-4" />
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-foreground">
            Get this report every morning
          </span>
          <span className="text-[11px] text-muted-foreground">
            Auto-audit your storefront daily and post it to your team
          </span>
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        {connected ? (
          <div className="flex items-center gap-2 text-[13px] font-medium text-primary">
            <Check className="size-4" />
            Connected to {connected === "slack" ? "Slack" : "Microsoft Teams"} —
            daily digest at 9:00 AM
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <ChannelButton
              target="connect-slack"
              glyph="S"
              color="#4A154B"
              label="Connect Slack"
            />
            <ChannelButton
              target="connect-teams"
              glyph="T"
              color="#4B53BC"
              label="Connect Teams"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function PRCard({ pr }: { pr: PRState }) {
  return (
    <div className="my-2 w-full animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border border-border bg-card duration-500">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-lg",
            pr.merged
              ? "bg-primary/10 text-primary"
              : "bg-muted text-foreground",
          )}
        >
          <GitPullRequest className="size-4" />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          #{pr.number} · {pr.title}
        </span>
        <span
          className={cn(
            "ml-auto rounded-full px-2.5 py-1 text-[11px] font-medium",
            pr.merged
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {pr.merged ? "Merged" : "Open"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-4 py-3 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          <GitBranch01 className="size-3" />
          {pr.branch}
        </span>
        <span>{pr.files} files changed</span>
        <span className="font-medium text-primary">+{pr.additions}</span>
        <span className="font-medium text-destructive">−{pr.deletions}</span>
        <span className="inline-flex items-center gap-1.5">
          {pr.checks === "running" ? (
            <>
              <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-foreground" />
              Checks running…
            </>
          ) : (
            <>
              <Check className="size-3.5 text-primary" />
              All checks passed
            </>
          )}
        </span>
      </div>

      {!pr.merged && (
        <div className="border-t border-border px-4 py-3">
          <Button
            type="button"
            size="sm"
            data-demo-target="merge-pr"
            disabled={pr.checks !== "passed"}
            className="gap-1.5"
          >
            <GitPullRequest className="size-3.5" />
            Merge pull request
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org CTA card — "this org needs you" rendered inline in the personal chat,
// with a button that navigates into the org (the Director performs the hop).
// ---------------------------------------------------------------------------

export interface OrgCtaState {
  orgName: string;
  glyph: string;
  /** tailwind classes for the org's colored tile */
  tile: string;
  headline: string;
  body: string;
  button: string;
  /** ghost-cursor target id for the navigate button */
  target: string;
}

export function OrgCtaCard({ cta }: { cta: OrgCtaState }) {
  return (
    <div className="my-2 w-full animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border border-border bg-card duration-500">
      <div className="flex items-center gap-3 p-4">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
            cta.tile,
          )}
        >
          {cta.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {cta.headline}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{cta.body}</div>
        </div>
        <Button size="sm" data-demo-target={cta.target} className="shrink-0">
          {cta.button}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
