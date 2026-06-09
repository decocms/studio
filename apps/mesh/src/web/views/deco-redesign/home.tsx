// Home — Deco's morning brief for ONE storefront agent (no "projects").
// Layout copies Figma node 8243-11389: a greeting + New task button, then the
// live finding UI Deco summoned for you (its spike graph), then important
// highlights, then suggestions. Findings are REAL threads (sidebar + chat), so
// everything here stays related to the tasks you can open.
import { cn } from "@deco/ui/lib/utils.ts";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Activity,
  AlertSquare,
  Bell01,
  ChevronRight,
  Plus,
  SearchSm,
  Stars02,
  Target04,
  Zap,
} from "@untitledui/icons";
import { toast } from "sonner";
import { useProjectContext } from "@decocms/mesh-sdk";
import { HOME_DRAFT_KEY, writeChatDraft } from "@/web/lib/chat-draft";
import type { TiptapDoc } from "@/web/components/chat/types";
import {
  DECO,
  effectiveState,
  INCIDENTS,
  type Incident,
  type IncidentState,
} from "./mock-data";
import { CMS_PROPOSALS } from "./mock-cms";
import { GOALS } from "./mock-goals";
import { useOverrides } from "./mock-store";
import { GoalSummaryCard } from "./goal-detail";
import { SectionLabel, SpikeGraph } from "./primitives";

const SEV_DOT: Record<Incident["severity"], string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-muted-foreground",
};

const METRIC_LABEL: Record<string, string> = {
  "inc-cache-dip": "Cache hit %",
  "inc-pagination": "Sessions reaching page 2",
};

const STATE_META: Record<IncidentState, { label: string; tone: string }> = {
  needs_review: { label: "Needs review", tone: "text-foreground" },
  in_progress: { label: "Shipping", tone: "text-muted-foreground" },
  resolved: { label: "Done", tone: "text-success" },
  watching: { label: "Watching", tone: "text-muted-foreground" },
  acknowledged: { label: "Acknowledged", tone: "text-muted-foreground" },
  dismissed: { label: "Dismissed", tone: "text-muted-foreground" },
};

export function RedesignHome({
  onOpen,
  onNewTask,
  onOpenInbox,
  onOpenGoal,
}: {
  onOpen: (id: string) => void;
  onNewTask: () => void;
  onOpenInbox: () => void;
  onOpenGoal: (id: string) => void;
}) {
  const overrides = useOverrides();
  const st = (i: Incident) => effectiveState(i, overrides);
  const review = INCIDENTS.filter((i) => st(i) === "needs_review");
  const critical = review.filter((i) => i.severity === "critical");
  const featured = critical[0] ?? review[0] ?? null;
  // The rest of Deco's findings (everything except the one summoned above),
  // newest first, so the home shows the full latest activity — not just counts.
  const latest = INCIDENTS.filter((i) => i.id !== featured?.id);
  const proposals = CMS_PROPOSALS.filter(
    (p) => effectiveState(p, overrides) === "needs_review",
  );
  const otherReview = review.filter((i) => i.id !== featured?.id);
  const autoDone = INCIDENTS.filter(
    (i) => st(i) === "resolved" && i.autonomy === "auto",
  );
  const watching = INCIDENTS.filter((i) => st(i) === "watching");
  const brief = buildBrief({
    featured,
    otherReview,
    autoDone,
    watching,
    proposalCount: proposals.length,
  });

  // The "New task" dropdown offers a few tasks tied to what the brief just
  // said, then a blank "New task". Picking one seeds the composer draft so the
  // real Chat.Input (in NewTaskDialog) opens pre-filled with that prompt.
  const { locator } = useProjectContext();
  const taskSuggestions = buildTaskSuggestions({
    featured,
    autoDone,
    watching,
  });
  const startTask = (prompt: string) => {
    writeChatDraft(sessionStorage, locator, HOME_DRAFT_KEY, promptDoc(prompt));
    onNewTask();
  };

  return (
    <div className="relative mx-auto flex w-full max-w-[900px] flex-col gap-10 px-10 py-10">
      <Greeting
        brief={brief}
        suggestions={taskSuggestions}
        onStartTask={startTask}
        onNewTask={onNewTask}
      />

      <GoalsSection onOpenGoal={onOpenGoal} />

      {featured && (
        <FeaturedFinding
          incident={featured}
          onOpen={() => onOpen(featured.id)}
        />
      )}

      <Highlights
        reviewCount={review.length}
        criticalCount={critical.length}
        onOpenInbox={onOpenInbox}
      />

      {latest.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Latest findings
            </h2>
            <button
              type="button"
              onClick={onOpenInbox}
              className="inline-flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
            >
              View all in inbox
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
            {latest.map((i) => (
              <FindingRow
                key={i.id}
                incident={i}
                state={st(i)}
                onOpen={() => onOpen(i.id)}
              />
            ))}
          </div>
        </section>
      )}

      {RECENT_VIEWS.length > 0 && (
        <section>
          <SectionLabel>Recently viewed</SectionLabel>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {RECENT_VIEWS.map((v) => (
              <RecentViewCard
                key={v.name}
                view={v}
                onOpen={() => toast(`Opening ${v.name}…`)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionLabel>Suggestions</SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={onNewTask}
              className="flex h-40 flex-col justify-between rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring/40 hover:bg-accent/30"
            >
              <s.icon size={18} className="text-muted-foreground" />
              <span className="text-sm text-foreground">{s.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

const SUGGESTIONS: { label: string; icon: typeof Activity }[] = [
  { label: "Run a full health scan", icon: Activity },
  { label: "Summarize yesterday's errors", icon: Stars02 },
  { label: "Check Core Web Vitals", icon: Zap },
  { label: "Review SEO on new pages", icon: SearchSm },
];

// Recently viewed = the MCP-app views you opened last. Each renders a live
// preview in a 4:3 iframe (mocked here with self-contained srcDoc so it shows
// offline without X-Frame-Options issues) + the view's name, nothing else.
interface RecentView {
  name: string;
  srcDoc: string;
}

const previewDoc = (bg: string, color: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:${bg};color:${color};box-sizing:border-box;overflow:hidden">${body}</body>`;

const RECENT_VIEWS: RecentView[] = [
  {
    name: "Storefront — Home hero",
    srcDoc: previewDoc(
      "linear-gradient(135deg,#fde4cf,#fbc4ab)",
      "#7a3b1d",
      `<div style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center"><div><div style="font-size:11px;letter-spacing:2px">DIA DAS MÃES</div><div style="font-size:22px;font-weight:600;margin-top:6px">Para ela, com amor</div><div style="margin-top:12px;display:inline-block;background:#7a3b1d;color:#fff;font-size:11px;padding:6px 14px;border-radius:999px">Ver presentes</div></div></div>`,
    ),
  },
  {
    name: "Errors over time",
    srcDoc: previewDoc(
      "#ffffff",
      "#111827",
      `<div style="padding:14px"><div style="font-size:11px;color:#6b7280">Errors over time · last 13h</div><div style="font-size:20px;font-weight:600;margin-top:2px">7,906</div><div style="display:flex;align-items:flex-end;gap:5px;height:96px;margin-top:12px">${[18, 14, 16, 22, 30, 44, 58, 78, 96, 88, 70, 54, 40].map((h) => `<div style="flex:1;background:#ef4444;border-radius:2px;height:${h}%"></div>`).join("")}</div></div>`,
    ),
  },
  {
    name: "Core Web Vitals",
    srcDoc: previewDoc(
      "#ffffff",
      "#111827",
      `<div style="padding:14px"><div style="font-size:11px;color:#6b7280">Core Web Vitals · mobile</div><div style="display:flex;gap:20px;margin-top:16px">${[
        ["1.8s", "LCP", "#16a34a"],
        ["42ms", "INP", "#16a34a"],
        ["0.04", "CLS", "#16a34a"],
      ]
        .map(
          ([v, l, c]) =>
            `<div><div style="font-size:22px;font-weight:600;color:${c}">${v}</div><div style="font-size:10px;color:#6b7280;margin-top:2px">${l}</div></div>`,
        )
        .join(
          "",
        )}</div><div style="margin-top:16px;height:6px;border-radius:999px;background:#dcfce7"><div style="height:100%;width:78%;border-radius:999px;background:#16a34a"></div></div></div>`,
    ),
  },
];

function RecentViewCard({
  view,
  onOpen,
}: {
  view: RecentView;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-1.5 text-left transition-colors hover:border-ring/40"
    >
      <div className="aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-muted">
        <iframe
          title={view.name}
          srcDoc={view.srcDoc}
          loading="lazy"
          sandbox=""
          className="pointer-events-none h-full w-full border-0"
        />
      </div>
      <span className="truncate px-1 pb-0.5 text-sm text-foreground">
        {view.name}
      </span>
    </button>
  );
}

// Goals are the root object now: the home leads with them, and findings roll up
// under each (visible in the goal detail). Each card shows the metric + trend,
// the autonomy dial (wired to the shared store), how many loops are running, and
// how many need your review.
function GoalsSection({ onOpenGoal }: { onOpenGoal: (id: string) => void }) {
  if (GOALS.length === 0) return null;
  return (
    <section>
      <SectionLabel>Your goals</SectionLabel>
      <div className="grid gap-3 md:grid-cols-3">
        {GOALS.map((g) => (
          <GoalSummaryCard
            key={g.id}
            goal={g}
            onOpen={() => onOpenGoal(g.id)}
          />
        ))}
      </div>
    </section>
  );
}

function Greeting({
  brief,
  suggestions,
  onStartTask,
  onNewTask,
}: {
  brief: string;
  suggestions: string[];
  onStartTask: (prompt: string) => void;
  onNewTask: () => void;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">Updated 5m ago</div>
      <p className="mt-4 text-xl leading-snug text-foreground">Hi Rafael,</p>
      <p className="mt-2 max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
        {brief}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              <Plus size={16} />
              New goal
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            {suggestions.map((s) => (
              <DropdownMenuItem
                key={s}
                onSelect={() => onStartTask(s)}
                className="items-start gap-2"
              >
                <Stars02
                  size={14}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="text-sm">{s}</span>
              </DropdownMenuItem>
            ))}
            {suggestions.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={() =>
                onStartTask(
                  "I want to set a new goal. Help me define the outcome, how we'll measure it, and the constraints — then run it in closed loops.",
                )
              }
              className="gap-2"
            >
              <Target04 size={14} className="shrink-0 text-muted-foreground" />
              <span className="text-sm">New goal</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onNewTask} className="gap-2">
              <Plus size={14} className="shrink-0 text-muted-foreground" />
              <span className="text-sm">New task</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** A minimal Tiptap doc holding a single line of text — used to seed the
 *  composer draft so the New Task modal opens pre-filled with a suggestion. */
function promptDoc(text: string): TiptapDoc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** Up to 3 task prompts tied to the current brief — phrased as the user asking
 *  Deco — so the dropdown's suggestions stay related to what was just read. */
function buildTaskSuggestions({
  featured,
  autoDone,
  watching,
}: {
  featured: Incident | null;
  autoDone: Incident[];
  watching: Incident[];
}): string[] {
  const out: string[] = [];
  if (featured) {
    out.push(`Walk me through "${featured.title}" and the fix you drafted.`);
  }
  out.push("Summarize everything you found today and what still needs me.");
  if (autoDone.length > 0 || watching.length > 0) {
    out.push("What did you handle on your own, and what are you watching?");
  } else {
    out.push("Run a full health scan now.");
  }
  return out.slice(0, 3);
}

/** Compose Deco's morning brief — a short summary of the live state: the most
 *  urgent finding, then counts for the rest, what it handled, and content to
 *  review. Stays terse (a résumé, not a report) and recomputes as you act. */
function buildBrief({
  featured,
  otherReview,
  autoDone,
  watching,
  proposalCount,
}: {
  featured: Incident | null;
  otherReview: Incident[];
  autoDone: Incident[];
  watching: Incident[];
  proposalCount: number;
}): string {
  const parts: string[] = [];

  if (featured) {
    parts.push(
      featured.fix
        ? `I caught ${featured.brief}, and a fix is ready for your approval.`
        : `I caught ${featured.brief}.`,
    );
  }

  if (otherReview.length > 0) {
    const noun = otherReview.length === 1 ? "finding needs" : "findings need";
    parts.push(`${otherReview.length} more ${noun} a look.`);
  }

  if (autoDone.length > 0 && watching.length > 0) {
    parts.push(
      `I handled ${autoDone.length} on my own and I'm watching ${watching.length} more.`,
    );
  } else if (autoDone.length > 0) {
    parts.push(`I handled ${autoDone.length} on my own.`);
  } else if (watching.length > 0) {
    parts.push(`I'm keeping an eye on ${watching.length} more.`);
  }

  if (proposalCount > 0) {
    const noun = proposalCount === 1 ? "content update" : "content updates";
    parts.push(`Plus ${proposalCount} ${noun} to review.`);
  }

  if (parts.length === 0) {
    return "Everything's healthy this morning. Nothing needs your review.";
  }
  return parts.join(" ");
}

function FindingRow({
  incident,
  state,
  onOpen,
}: {
  incident: Incident;
  state: IncidentState;
  onOpen: () => void;
}) {
  const meta = STATE_META[state];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent/40"
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          SEV_DOT[incident.severity],
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {incident.title}
      </span>
      <span className="text-xs text-muted-foreground">
        {incident.detectedAt}
      </span>
      <span className={cn("w-20 text-right text-xs", meta.tone)}>
        {meta.label}
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The finding Deco summoned onto the home: the top issue + its live graph. */
function FeaturedFinding({
  incident,
  onOpen,
}: {
  incident: Incident;
  onOpen: () => void;
}) {
  const metricLabel = METRIC_LABEL[incident.id] ?? "Errors / min";
  return (
    <section className="relative">
      <SectionLabel>Deco flagged this for you</SectionLabel>
      <img
        src="/home/capybara.png"
        alt=""
        aria-hidden
        className="pointer-events-none absolute -top-8 right-4 z-10 h-20 w-auto select-none"
      />
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <span
            className={cn("size-2 rounded-full", SEV_DOT[incident.severity])}
          />
          <span className="text-base font-medium text-foreground">
            {incident.title}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {incident.detectedAt}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{incident.blurb}</p>
        {incident.spike.length > 0 && (
          <div className="mt-4 rounded-lg border border-border bg-background p-4">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{metricLabel} · last 2h</span>
              <span>baseline ~{incident.baseline.toLocaleString()}</span>
            </div>
            <SpikeGraph
              points={incident.spike}
              baseline={incident.baseline}
              tone="destructive"
            />
          </div>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button size="sm" className="ml-auto" onClick={onOpen}>
            Review
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </section>
  );
}

function Highlights({
  reviewCount,
  criticalCount,
  onOpenInbox,
}: {
  reviewCount: number;
  criticalCount: number;
  onOpenInbox: () => void;
}) {
  return (
    <section>
      <SectionLabel>Important highlights</SectionLabel>
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
        <button
          type="button"
          onClick={onOpenInbox}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent/40"
        >
          <Bell01 size={16} className="shrink-0 text-muted-foreground" />
          <span className="text-sm text-foreground">
            {reviewCount}{" "}
            {reviewCount === 1 ? "finding needs" : "findings need"} your review
            across {DECO.storefront}.
          </span>
          <ChevronRight size={14} className="ml-auto text-muted-foreground" />
        </button>
        {criticalCount > 0 && (
          <button
            type="button"
            onClick={onOpenInbox}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent/40"
          >
            <AlertSquare size={16} className="shrink-0 text-destructive" />
            <span className="text-sm text-foreground">
              {criticalCount} critical{" "}
              {criticalCount === 1 ? "issue needs" : "issues need"} resolving.
            </span>
            <ChevronRight size={14} className="ml-auto text-muted-foreground" />
          </button>
        )}
      </div>
    </section>
  );
}
