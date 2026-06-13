// A second example world — same core, different matter. Fixture only.

import { z } from "zod";
import type { Domain } from "../../src/index";

export interface ContentCalendar {
  tenant: string;
  postsThisWeek: number;
  avgEngagementRate: number;
  backlog: string[];
}

export interface EngagementTarget {
  targetPostsPerWeek: number;
  targetEngagementRate: number;
}

interface EngagementGap {
  posts: number;
  engagement: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function fakeCalendarIO() {
  const db = new Map<string, ContentCalendar>();
  return {
    seed(tenant: string, c: Omit<ContentCalendar, "tenant">) {
      db.set(tenant, { tenant, ...c });
    },
    async read(tenant: string): Promise<ContentCalendar> {
      return structuredClone(db.get(tenant)!);
    },
    async apply(
      tenant: string,
      change: { kind: string; payload?: unknown },
    ): Promise<void> {
      const c = db.get(tenant)!;
      if (change.kind === "schedule_post") {
        c.postsThisWeek += 1;
        c.backlog = c.backlog.slice(1);
      }
      if (change.kind === "repurpose_top_post")
        c.avgEngagementRate = round(c.avgEngagementRate + 0.006);
    },
  };
}

export type CalendarIO = ReturnType<typeof fakeCalendarIO>;

export function calendarDomain(
  io: CalendarIO,
): Domain<ContentCalendar, EngagementTarget, EngagementGap> {
  return {
    name: "content-calendar",

    observe: (tenant) => io.read(tenant),

    gap: (c, t) => ({
      posts: t.targetPostsPerWeek - c.postsThisWeek,
      engagement: round(t.targetEngagementRate - c.avgEngagementRate),
    }),

    satisfied: (c, t) =>
      c.postsThisWeek >= t.targetPostsPerWeek &&
      c.avgEngagementRate >= t.targetEngagementRate,

    instructions:
      "You grow a creator's channel toward FIXED engagement targets you cannot change. " +
      "Schedule posts and repurpose top content to close the gap; stop when closed.",

    actions: [
      {
        kind: "schedule_post",
        description: "Schedule the next backlog item to raise weekly cadence.",
        schema: z.object({ idea: z.string() }),
        apply: (tenant, input) =>
          io.apply(tenant, { kind: "schedule_post", payload: input }),
      },
      {
        kind: "repurpose_top_post",
        description:
          "Repurpose the best-performing post to lift average engagement.",
        schema: z.object({ format: z.enum(["short", "carousel", "thread"]) }),
        apply: (tenant, input) =>
          io.apply(tenant, { kind: "repurpose_top_post", payload: input }),
      },
    ],

    plan: ({ state, gap }) => {
      const steps: Array<{ kind: string; input: unknown }> = [];
      if (gap.posts > 0)
        steps.push({
          kind: "schedule_post",
          input: { idea: state.backlog[0] ?? "evergreen tip" },
        });
      if (gap.engagement > 0)
        steps.push({ kind: "repurpose_top_post", input: { format: "short" } });
      return steps;
    },

    prompt: ({ state, target, gap, tenant, moverVersion }) =>
      `Tenant ${tenant}, goal v${moverVersion}.\n` +
      `Targets — posts/wk >= ${target.targetPostsPerWeek}, engagement >= ${target.targetEngagementRate}.\n` +
      `Current — posts ${state.postsThisWeek}, engagement ${state.avgEngagementRate}.\n` +
      `Gap — posts ${gap.posts}, engagement ${gap.engagement}.\n` +
      `Backlog — ${state.backlog.join(", ") || "(empty)"}.`,
  };
}
