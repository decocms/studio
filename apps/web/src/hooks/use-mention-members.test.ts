import { expect, test } from "bun:test";
import { mergeMembers, type MentionMember } from "./use-mention-members.ts";

const ana: MentionMember = {
  id: "u1",
  name: "Ana",
  email: "ana@x.dev",
  image: null,
};

test("an unchanged member keeps its identity, so its row doesn't re-render", () => {
  const bo: MentionMember = {
    id: "u2",
    name: "Bo",
    email: "b@x.dev",
    image: null,
  };
  const merged = mergeMembers([ana], [{ ...ana }, bo]);
  expect(merged[0]).toBe(ana);
  expect(merged[1]).toBe(bo);
});

test("an edited member is replaced, not kept", () => {
  const renamed = { ...ana, name: "Ana Silva" };
  expect(mergeMembers([ana], [renamed])[0]).toBe(renamed);
});

test("a removed member is gone — the fetch is the truth", () => {
  expect(mergeMembers([ana], [])).toEqual([]);
});

test("no cache is just the fetched list", () => {
  expect(mergeMembers(undefined, [ana])).toEqual([ana]);
});
