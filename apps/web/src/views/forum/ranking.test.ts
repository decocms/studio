import { describe, expect, it } from "bun:test";
import { sortTopics } from "./ranking";
import type { ForumTopic } from "./use-forum";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function topic(id: string, over: Partial<ForumTopic>): ForumTopic {
  return {
    id,
    keySeq: 1,
    channelId: "vir_1",
    title: id,
    body: null,
    status: "triage",
    author: { id: "u", name: "U", image: null },
    assigneeId: null,
    tags: [],
    votes: 0,
    viewerVoted: false,
    replyCount: 0,
    createdAt: hoursAgo(1),
    lastActivityAt: hoursAgo(1),
    ...over,
  };
}

describe("sortTopics", () => {
  const busyToday = topic("busy-today", { votes: 5, replyCount: 4 });
  const popularOld = topic("popular-old", {
    votes: 40,
    replyCount: 10,
    createdAt: hoursAgo(24 * 30),
    lastActivityAt: hoursAgo(24 * 30),
  });
  const quietNew = topic("quiet-new", { createdAt: hoursAgo(0.5) });
  const all = [popularOld, quietNew, busyToday];

  it("hot favors recent activity over old popularity", () => {
    expect(sortTopics(all, "hot", NOW)[0]?.id).toBe("busy-today");
  });

  it("top is by votes, new is by creation", () => {
    expect(sortTopics(all, "top", NOW)[0]?.id).toBe("popular-old");
    expect(sortTopics(all, "new", NOW)[0]?.id).toBe("quiet-new");
  });

  it("unanswered keeps only topics without replies", () => {
    expect(sortTopics(all, "unanswered", NOW).map((t) => t.id)).toEqual([
      "quiet-new",
    ]);
  });
});
