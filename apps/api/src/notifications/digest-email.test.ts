import { describe, expect, test } from "bun:test";
import { buildDigestEmail, type DigestRow } from "./digest-email";
import { isValidEmail } from "./dbos-digest";

const row = (over: Partial<DigestRow> = {}): DigestRow => ({
  id: "notif_1",
  type: "commented",
  taskTitle: "Fix the header",
  taskKeySeq: 7,
  actorName: "Ada",
  orgSlug: "decocms",
  ...over,
});

test("singular vs plural subject", () => {
  expect(buildDigestEmail([row()], "https://x").subject).toBe(
    "1 update on your tasks",
  );
  expect(buildDigestEmail([row(), row()], "https://x").subject).toBe(
    "2 updates on your tasks",
  );
});

test("links a keyed task and names the actor", () => {
  const { html } = buildDigestEmail([row()], "https://x");
  expect(html).toContain("https://x/decocms/t/DECO-07");
  expect(html).toContain("Ada commented on");
});

test("a null actor is the agent, and an unkeyed task has no link", () => {
  const { html } = buildDigestEmail(
    [row({ actorName: null, taskKeySeq: null })],
    "https://x",
  );
  expect(html).toContain("The agent commented on");
  expect(html).not.toContain("/t/");
});

test("escapes titles", () => {
  const { html } = buildDigestEmail(
    [row({ taskTitle: "<script>x</script>" })],
    "https://x",
  );
  expect(html).not.toContain("<script>");
});

describe("email validation", () => {
  test("accepts valid email addresses", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("user+tag@example.co.uk")).toBe(true);
    expect(isValidEmail("a@b.c")).toBe(true);
  });

  test("rejects invalid email formats", () => {
    expect(isValidEmail("no-at-sign.com")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("user@")).toBe(false);
    expect(isValidEmail("user@nodomain")).toBe(false);
    expect(isValidEmail("user @example.com")).toBe(false);
  });

  test("rejects emails exceeding 254 characters", () => {
    const long = "a".repeat(245) + "@example.com";
    expect(isValidEmail(long)).toBe(false);
  });

  test("accepts emails at the 254 character limit", () => {
    const max = "a".repeat(242) + "@example.com";
    expect(isValidEmail(max)).toBe(true);
  });

  test("rejects emails that are too short", () => {
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("ab")).toBe(false);
  });
});
