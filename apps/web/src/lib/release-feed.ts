import {
  CheckCircle,
  CpuChip01,
  FilterLines,
  Inbox01,
  Monitor01,
  Stars02,
  Users03,
  Zap,
} from "@untitledui/icons";
import type { ComponentType } from "react";

export interface ReleaseBullet {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
}

export interface Release {
  id: string;
  date: string; // ISO date
  title: string;
  eyebrow?: string;
  bullets: ReleaseBullet[];
  // href navigates; action is handled by the card (currently only opening
  // the desktop-app download dialog).
  cta?:
    | { label: string; href: string }
    | { label: string; action: "download-app" };
  learnMoreHref?: string;
}

/**
 * Release feed, newest first. Add new entries at the top.
 * The latest entry is the floating-card candidate; older entries live only in the inbox.
 */
export const RELEASES: Release[] = [
  {
    id: "native-app-macos",
    date: "2026-07-30",
    eyebrow: "Now Available",
    title: "The Studio app is here",
    bullets: [
      {
        icon: Zap,
        title: "Faster CMS previews",
        body: "Every draft gets its own git worktree on your machine, so previews render instantly as you edit.",
      },
      {
        icon: Monitor01,
        title: "Apple Silicon only — Windows coming soon",
        body: "Today's builds target macOS on Apple Silicon; Windows is next.",
      },
      {
        icon: CpuChip01,
        title: "Works on more modest machines",
        body: "The app is entirely rewritten in Rust, with a smaller memory footprint than the Bun-based runtime.",
      },
      {
        icon: Stars02,
        title: "Native Claude Code & Codex support",
        body: "State-of-the-art coding agents, running natively against your local files.",
      },
    ],
    cta: { label: "Install on Mac", action: "download-app" },
    learnMoreHref: "https://github.com/decocms/studio/releases",
  },
  {
    id: "codex-gpt-5-6-defaults",
    date: "2026-07-13",
    eyebrow: "Now Available",
    title: "Codex defaults move to GPT-5.6",
    bullets: [
      {
        icon: Stars02,
        title: "Sol leads Thinking",
        body: "Codex Thinking now defaults to `gpt-5.6-sol` for deeper coding and reasoning work.",
      },
      {
        icon: CheckCircle,
        title: "Terra balances Smart",
        body: "The Smart tier now uses `gpt-5.6-terra`, replacing GPT-5.4 as the default balanced Codex model.",
      },
      {
        icon: Zap,
        title: "Luna speeds up Fast",
        body: "The Fast tier and lightweight Codex title generation now use `gpt-5.6-luna`. Existing threads that reference older GPT-5.4 or GPT-5.5 model IDs remain supported.",
      },
    ],
  },
  {
    id: "claude-sonnet-5",
    date: "2026-06-30",
    eyebrow: "Now Available",
    title: "Claude Sonnet 5 powers the Smart tier",
    bullets: [
      {
        icon: Stars02,
        title: "More agentic coding",
        body: "Sonnet 5 is Anthropic's strongest Sonnet model yet, with improved reasoning, tool use, coding, and knowledge work compared with Sonnet 4.6.",
      },
      {
        icon: CheckCircle,
        title: "Available in Claude Code",
        body: "The Claude Code harness now pins the Smart tier to the new `claude-sonnet-5` model id so new sessions use Sonnet 5 by default.",
      },
      {
        icon: Zap,
        title: "Nothing to change",
        body: "Existing Smart-tier chats and agents pick up Sonnet 5 automatically. Thinking remains on Opus 4.8 1M.",
      },
    ],
    learnMoreHref: "https://www.anthropic.com/news/claude-sonnet-5",
  },
  {
    id: "fable-5-suspension",
    date: "2026-06-13",
    eyebrow: "Important Update",
    title: "Fable 5 & Mythos 5 suspended — Opus 4.8 takes over",
    bullets: [
      {
        icon: CheckCircle,
        title: "US government directive",
        body: "Anthropic received an export control directive requiring the suspension of Fable 5 and Mythos 5 access for all users, citing national security concerns. Anthropic is complying while it works to resolve the matter.",
      },
      {
        icon: Stars02,
        title: "Opus 4.8 steps in as the Thinking tier",
        body: "The Thinking tier now runs on Claude Opus 4.8, which remains fully operational. Performance on most tasks is comparable, and Anthropic reports more than 95% of sessions were unaffected by the Fable 5 classifiers anyway.",
      },
      {
        icon: Zap,
        title: "Nothing to change",
        body: "The switch is automatic — any chat or agent already using the Thinking tier is now served by Opus 4.8. Anthropic will share further details within 24 hours.",
      },
    ],
    learnMoreHref: "https://www.anthropic.com/news/fable-mythos-access",
  },
  {
    id: "claude-fable-5",
    date: "2026-06-09",
    eyebrow: "Now Available",
    title: "Claude Fable 5 leads the Thinking tier",
    bullets: [
      {
        icon: Stars02,
        title: "State-of-the-art reasoning",
        body: "Fable 5 takes the Thinking tier, posting top scores across software engineering, knowledge work, and vision — and outperforming Opus 4.8 on nearly every benchmark Anthropic tested.",
      },
      {
        icon: CheckCircle,
        title: "Safety without the slowdown",
        body: "New classifiers route the small slice of high-risk requests (cybersecurity, bio/chem) back to Opus 4.8. Anthropic reports more than 95% of sessions never trigger a fallback.",
      },
      {
        icon: Zap,
        title: "Nothing to change",
        body: "Chats and agents pick up Fable 5 automatically wherever the Thinking tier is selected. Opus 4.8 stays available as the safety fallback.",
      },
    ],
    learnMoreHref: "https://www.anthropic.com/news/claude-fable-5-mythos-5",
  },
  {
    id: "claude-opus-4-8",
    date: "2026-05-28",
    eyebrow: "Now Available",
    title: "Claude Opus 4.8 is the new default",
    bullets: [
      {
        icon: Stars02,
        title: "Smarter thinking, same price",
        body: "Opus 4.8 now leads the Thinking and Smarter tiers, outperforming Opus 4.7 on coding, reasoning, and agent tasks at the same cost.",
      },
      {
        icon: CheckCircle,
        title: "More honest answers",
        body: "It's about 4× less likely to let a code flaw slip through unflagged, and surfaces uncertainty instead of making unsupported claims.",
      },
      {
        icon: Zap,
        title: "Nothing to change",
        body: "Chats and agents pick up Opus 4.8 automatically wherever the Thinking or Smarter tier is selected.",
      },
    ],
    learnMoreHref: "https://www.anthropic.com/news/claude-opus-4-8",
  },
  {
    id: "enhanced-sidebar",
    date: "2026-05-28",
    eyebrow: "Now Available",
    title: "Enhanced sidebar",
    bullets: [
      {
        icon: Stars02,
        title: "A clearer view of what's running",
        body: "See every task in your organization at a glance, with each agent and status group laid out so you can spot active work without hunting for it.",
      },
      {
        icon: FilterLines,
        title: "Browse one group at a time",
        body: "Expand the groups you care about and pull in more results on demand — no more endless scrolling to find an older conversation.",
      },
      {
        icon: CheckCircle,
        title: "Polished and steadier",
        body: "Several sidebar bugs are fixed, including empty agent groups showing the right action and status filters returning the right tasks.",
      },
    ],
  },
  {
    id: "smarter-task-delegation",
    date: "2026-05-27",
    eyebrow: "Now Available",
    title: "Smarter task delegation",
    bullets: [
      {
        icon: Users03,
        title: "Real results from delegated agents",
        body: "When one agent hands work to another, you'll see the full report inline — no more empty replies hiding the work that was done.",
      },
      {
        icon: Zap,
        title: "Same powers, top to bottom",
        body: "Delegated agents now work with the same tools, context, and memory as the agent that called them, so complex multi-agent investigations finish on the first try.",
      },
      {
        icon: CheckCircle,
        title: "Clearer progress signals",
        body: "When a delegated task hits its limit or runs into a problem, you get a plain-language message instead of a silent stall.",
      },
    ],
  },
  {
    id: "sidebar-task-groups",
    date: "2026-05-27",
    eyebrow: "Now Available",
    title: "Redesigned sidebar",
    bullets: [
      {
        icon: Stars02,
        title: "Group by agent or status",
        body: "Switch the task list between grouping by agent or by status — pick whichever matches how you're working right now.",
      },
      {
        icon: FilterLines,
        title: "Sharper filters",
        body: "Narrow the list to your tasks, manual chats, or automations from a compact filter row above the groups.",
      },
    ],
  },
  {
    id: "release-channel",
    date: "2026-05-26",
    eyebrow: "Now Available",
    title: "Release announcements",
    bullets: [
      {
        icon: Stars02,
        title: "Heads-up when features ship",
        body: "New releases surface in a corner card the first time you see them, then stick around in your inbox.",
      },
      {
        icon: Inbox01,
        title: "Unified inbox",
        body: "Org invitations and product updates now share one chronological feed in the sidebar.",
      },
    ],
  },
];
