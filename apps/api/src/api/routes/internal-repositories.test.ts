import { describe, expect, test } from "bun:test";
import type { ChangeRequestHistoryItem } from "@/git-providers";
import { changeRequestWire } from "./internal-repositories";

function historyItem(
  overrides: Partial<ChangeRequestHistoryItem> = {},
): ChangeRequestHistoryItem {
  return {
    number: 12,
    title: "Ship the checkout redesign",
    url: "https://example.dev/acme/storefront/pull/12",
    state: "merged",
    author: { login: "ana", isBot: false },
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-02-04T09:00:00Z",
    mergedAt: "2026-02-03T18:00:00Z",
    closedAt: "2026-02-03T18:00:00Z",
    base: "main",
    head: "feat/checkout",
    additions: 120,
    deletions: 30,
    commits: {
      count: 1,
      items: [{ sha: "sha-1", date: "2026-02-01T11:00:00Z" }],
    },
    ...overrides,
  };
}

describe("changeRequestWire", () => {
  test("every field crosses the wire, renamed to the consumer's convention", () => {
    expect(changeRequestWire(historyItem())).toEqual({
      number: 12,
      title: "Ship the checkout redesign",
      url: "https://example.dev/acme/storefront/pull/12",
      state: "merged",
      author: { login: "ana", is_bot: false },
      created_at: "2026-02-01T10:00:00Z",
      updated_at: "2026-02-04T09:00:00Z",
      merged_at: "2026-02-03T18:00:00Z",
      closed_at: "2026-02-03T18:00:00Z",
      base: "main",
      head: "feat/checkout",
      additions: 120,
      deletions: 30,
      commits: {
        count: 1,
        items: [{ sha: "sha-1", date: "2026-02-01T11:00:00Z" }],
      },
    });
  });

  test("an unknown stays null on the wire — never 0, never an empty list", () => {
    const wire = changeRequestWire(
      historyItem({
        additions: null,
        deletions: null,
        commits: null,
        mergedAt: null,
      }),
    );
    expect(wire.additions).toBeNull();
    expect(wire.deletions).toBeNull();
    expect(wire.commits).toBeNull();
    expect(wire.merged_at).toBeNull();
  });

  test("a bot author is flagged under the snake_case key the consumer reads", () => {
    const wire = changeRequestWire(
      historyItem({ author: { login: "renovate[bot]", isBot: true } }),
    );
    expect(wire.author).toEqual({ login: "renovate[bot]", is_bot: true });
  });
});
