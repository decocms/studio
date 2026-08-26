import { expect, test } from "bun:test";
import { buildDigestEmail, type DigestRow } from "./digest-email";

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
