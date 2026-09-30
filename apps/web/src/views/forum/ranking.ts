/** Pure topic ranking for the forum's Hot / New / Top / Unanswered tabs. */

import type { ForumTopic } from "./use-forum";

export type ForumSort = "hot" | "new" | "top" | "unanswered";

const HOUR = 3_600_000;

/** Votes and replies, decayed by age: a busy topic from today outranks a
 *  popular one from last month. ponytail: computed over the loaded page; move
 *  into the list query once a channel paginates. */
function hotScore(topic: ForumTopic, now: number): number {
  const ageHours = (now - Date.parse(topic.lastActivityAt)) / HOUR;
  return (topic.votes + 2 * topic.replyCount + 1) / Math.pow(ageHours + 2, 1.5);
}

export function sortTopics(
  topics: ForumTopic[],
  sort: ForumSort,
  now: number,
): ForumTopic[] {
  const list =
    sort === "unanswered" ? topics.filter((t) => t.replyCount === 0) : topics;
  const by: Record<ForumSort, (a: ForumTopic, b: ForumTopic) => number> = {
    hot: (a, b) => hotScore(b, now) - hotScore(a, now),
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    top: (a, b) => b.votes - a.votes,
    unanswered: (a, b) => b.createdAt.localeCompare(a.createdAt),
  };
  return [...list].sort(by[sort]);
}
