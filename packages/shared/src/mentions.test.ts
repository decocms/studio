import { expect, test } from "bun:test";
import { mentionMarkdown, parseMentions } from "./mentions.ts";

test("parses ids, deduped, in first-seen order; ignores ordinary links", () => {
  const body = `Hi ${mentionMarkdown("usr_2", "Ana")} and ${mentionMarkdown(
    "usr_1",
    "Bo",
  )} — again ${mentionMarkdown("usr_2", "Ana")}. [docs](https://x.dev)`;
  expect(parseMentions(body)).toEqual(["usr_2", "usr_1"]);
});

test("a name with brackets can't break out of the link", () => {
  expect(parseMentions(mentionMarkdown("usr_1", "A]hi[B"))).toEqual(["usr_1"]);
});

test("no mentions is empty, not a throw", () => {
  expect(parseMentions("")).toEqual([]);
  expect(parseMentions("plain @ana text")).toEqual([]);
});
