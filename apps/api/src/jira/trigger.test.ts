import { describe, expect, it } from "bun:test";
import { movedByIntegration, parseWebhookTransition } from "./trigger";

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

/**
 * A run that moves its issue on is handing it over: the next fire waits for
 * that run to end instead of stopping it. Only the integration's own account
 * counts; anything uncertain is treated as a person, who takes over at once.
 */
describe("movedByIntegration", () => {
  const BOT = { accountId: "acc-bot", displayName: "Studio Bot" };
  const client = { myself: async () => BOT };

  it("is true for a move by the integration's account", async () => {
    expect(await movedByIntegration(client, BOT)).toBe(true);
  });

  it("is false for a move by a person", async () => {
    expect(
      await movedByIntegration(client, {
        accountId: "acc-ana",
        displayName: "Ana",
      }),
    ).toBe(false);
  });

  it("is false for a move with no author", async () => {
    expect(await movedByIntegration(client, null)).toBe(false);
  });

  it("is false when the integration's account cannot be read", async () => {
    const failing = {
      myself: async (): Promise<typeof BOT> => {
        throw new Error("401");
      },
    };
    expect(await movedByIntegration(failing, BOT)).toBe(false);
  });
});
