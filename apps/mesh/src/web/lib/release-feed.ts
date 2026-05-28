import {
  CheckCircle,
  FilterLines,
  Inbox01,
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
  cta?: { label: string; href: string };
  learnMoreHref?: string;
}

/**
 * Release feed, newest first. Add new entries at the top.
 * The latest entry is the floating-card candidate; older entries live only in the inbox.
 */
export const RELEASES: Release[] = [
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
