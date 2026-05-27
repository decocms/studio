import { FilterLines, Inbox01, Stars02 } from "@untitledui/icons";
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
