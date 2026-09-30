import { describe, expect, it } from "bun:test";
import { parseWebhookTransition } from "./trigger";

describe("parseWebhookTransition", () => {
  const updated = (items: Array<{ field: string; toString?: string }>) => ({
    webhookEvent: "jira:issue_updated",
    issue: { id: "10001", key: "EX-7" },
    changelog: { id: "5001", items },
  });

  it("reads the status an issue landed in, with the transition's identity", () => {
    expect(
      parseWebhookTransition(
        updated([
          { field: "assignee", toString: "Ana" },
          { field: "status", toString: "Doing" },
        ]),
      ),
    ).toEqual({
      issueId: "10001",
      issueKey: "EX-7",
      toStatus: "Doing",
      changelogId: "5001",
    });
  });

  /** Jira sends ids as numbers in some payloads and strings in others. */
  it("accepts numeric ids", () => {
    const payload = updated([{ field: "status", toString: "Doing" }]);
    const numeric = {
      ...payload,
      issue: { ...payload.issue, id: 10001 },
      changelog: { ...payload.changelog, id: 5001 },
    };
    expect(parseWebhookTransition(numeric)?.changelogId).toBe("5001");
  });

  it("is null for an update that did not touch the status", () => {
    expect(
      parseWebhookTransition(updated([{ field: "summary", toString: "x" }])),
    ).toBeNull();
  });

  it("is null for other events and for garbage", () => {
    expect(
      parseWebhookTransition({
        ...updated([]),
        webhookEvent: "comment_created",
      }),
    ).toBeNull();
    for (const bad of [
      null,
      "x",
      1,
      {},
      { webhookEvent: "jira:issue_updated" },
    ]) {
      expect(parseWebhookTransition(bad)).toBeNull();
    }
  });
});
