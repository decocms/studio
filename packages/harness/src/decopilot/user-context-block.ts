/**
 * Portable per-user context block renderer.
 *
 * Pure function over PRE-RESOLVED `HarnessUserContext` (read agent-side by
 * `prepareRun`, not via `ctx.storage`). Renders identity + shared history +
 * interests; skips any sub-block whose data is absent (e.g. desktop runs).
 */

import type {
  HarnessUserContext,
  PromptInterest,
  PromptThreadSummary,
} from "../types";

const MAX_INJECTED_INTERESTS = 3;

/** Absolute date label (YYYY-MM-DD) — request-stable so the cached system
 *  prefix isn't invalidated each turn the way a relative "3 mins ago" would. */
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "unknown date"
    : d.toISOString().slice(0, 10);
}

function renderInterestsSection(interests: PromptInterest[]): string {
  const lines = interests.map((i) => `- ${i.title}: ${i.summary}`);
  return `### What they're working toward

Most important first:

${lines.join("\n")}

When the conversation is open-ended or clearly related, gently surface one concrete next step toward these. Do NOT derail a focused task the user is already on, and never force an interest in when it isn't relevant.`;
}

function renderRecentThreadsSection(
  total: number,
  threads: PromptThreadSummary[],
): string {
  const lines = threads.map(
    (t) => `- "${t.title}" (${dateLabel(t.updated_at)})`,
  );
  return `### Your history together

You and this user have had ${total} previous conversation${total === 1 ? "" : "s"}. Most recent:

${lines.join("\n")}

Don't recap these unprompted, but use them so you recognize the user and pick up context naturally instead of treating them as a stranger.`;
}

export interface RenderUserContextOptions {
  user: { name?: string | null; email?: string | null };
  currentThreadId?: string;
  userContext: HarnessUserContext;
}

/** Build the per-user context block from pre-resolved data. Returns null when
 *  there's nothing worth a block of its own (only the closing instruction). */
export function renderUserContextBlock(
  opts: RenderUserContextOptions,
): string | null {
  const { user, userContext } = opts;
  const sections: string[] = [];

  if (user.name || user.email) {
    const name = user.name ?? user.email;
    const email = user.name && user.email ? ` (${user.email})` : "";
    sections.push(`### Who you're talking to

You're talking to ${name}${email}. Address them by name when it's natural.`);
  }

  const recent = userContext.recentThreads;
  if (recent && recent.total > 0) {
    const others = recent.threads
      .filter((t) => t.id !== opts.currentThreadId)
      .slice(0, 8);
    if (others.length > 0) {
      const total = opts.currentThreadId ? recent.total - 1 : recent.total;
      if (total > 0) {
        sections.push(renderRecentThreadsSection(total, others));
      }
    }
  }

  if (userContext.interests && userContext.interests.length > 0) {
    sections.push(
      renderInterestsSection(
        userContext.interests.slice(0, MAX_INJECTED_INTERESTS),
      ),
    );
  }

  sections.push(
    "When you learn a durable new goal the user is working toward — or clear progress on an existing one — call `update_interests` to keep this record current. Skip one-off questions.",
  );

  if (sections.length <= 1) return null;
  return `## About this user\n\n${sections.join("\n\n")}`;
}
