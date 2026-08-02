import { expect, test } from "bun:test";
import { formatNewComments } from "./task-comment-feed";

const comment = (
  over: Partial<Parameters<typeof formatNewComments>[0][number]>,
) => ({
  id: "cmt_1",
  authorName: "Ana",
  body: "ship it",
  mentions: [],
  ...over,
});

test("a mention is called out and carries the id to reply to", () => {
  const block = formatNewComments([
    comment({
      id: "cmt_mention",
      mentions: [{ kind: "user", id: "super-agent" }],
      body: "@Super Agent what about retries?",
    }),
  ]);
  expect(block).toContain("(mentions you)");
  expect(block).toContain("[comment_id: cmt_mention]");
  expect(block).toContain("what about retries?");
});

test("a comment that doesn't mention the agent is context, not a demand", () => {
  const block = formatNewComments([comment({ authorName: "Bo" })]);
  expect(block).not.toContain("(mentions you)");
  expect(block).toContain("Bo");
  // A mention of someone else is still not a mention of the agent.
  const other = formatNewComments([
    comment({ mentions: [{ kind: "user", id: "usr_other" }] }),
  ]);
  expect(other).not.toContain("(mentions you)");
});

test("multi-line bodies stay inside their own comment block", () => {
  const block = formatNewComments([comment({ body: "line one\nline two" })]);
  expect(block).toContain("  line one\n  line two");
});
