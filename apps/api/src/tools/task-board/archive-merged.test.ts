import { describe, expect, it } from "bun:test";
import { cardWorkLanded, groupByOrg, type PrLanding } from "./archive-merged";

const BR = { repoOwner: "acme", repoName: "storefront" };
const US = { repoOwner: "acme", repoName: "storefront-us" };

const merged = (repo: typeof BR): PrLanding => ({
  ...repo,
  state: "closed",
  merged: true,
});
const open = (repo: typeof BR): PrLanding => ({
  ...repo,
  state: "open",
  merged: false,
});
const abandoned = (repo: typeof BR): PrLanding => ({
  ...repo,
  state: "closed",
  merged: false,
});
const unreadable = (repo: typeof BR): PrLanding => ({
  ...repo,
  state: null,
  merged: null,
});

describe("cardWorkLanded", () => {
  it("lands a single merged PR", () => {
    expect(cardWorkLanded([merged(BR)])).toBe(true);
  });

  it("needs every repo the card touches, not every PR", () => {
    expect(cardWorkLanded([merged(BR), merged(US)])).toBe(true);
    expect(cardWorkLanded([merged(BR), open(US)])).toBe(false);
  });

  // Inverts `allPrsMerged`, which stranded a bounced card forever.
  it("ignores a PR the reviewer bounce abandoned in the same repo", () => {
    expect(cardWorkLanded([abandoned(BR), merged(BR)])).toBe(true);
  });

  it("holds while a repo still has an open PR, merged sibling or not", () => {
    expect(cardWorkLanded([merged(BR), open(BR)])).toBe(false);
    expect(cardWorkLanded([open(BR), open(BR)])).toBe(false);
  });

  it("never lands a repo whose PRs all closed unmerged", () => {
    expect(cardWorkLanded([abandoned(BR)])).toBe(false);
  });

  it("defers on an unreachable GitHub rather than landing on a guess", () => {
    expect(cardWorkLanded([unreadable(BR)])).toBe(false);
    expect(cardWorkLanded([merged(BR), unreadable(BR)])).toBe(false);
    expect(cardWorkLanded([merged(BR), unreadable(US)])).toBe(false);
  });

  it("accepts a merge reported without a state", () => {
    expect(cardWorkLanded([{ ...BR, state: null, merged: true }])).toBe(true);
  });

  it("groups repos case-insensitively, as GitHub does", () => {
    expect(
      cardWorkLanded([
        merged(BR),
        { ...BR, repoName: "StoreFront", state: "open", merged: false },
      ]),
    ).toBe(false);
  });

  it("never lands a card with no PRs at all", () => {
    expect(cardWorkLanded([])).toBe(false);
  });
});

describe("groupByOrg", () => {
  it("gives each org one leg, keeping its candidates together", () => {
    expect(
      groupByOrg([
        { id: "a", organizationId: "org-1" },
        { id: "b", organizationId: "org-2" },
        { id: "c", organizationId: "org-1" },
      ]),
    ).toEqual([
      { organizationId: "org-1", itemIds: ["a", "c"] },
      { organizationId: "org-2", itemIds: ["b"] },
    ]);
  });

  it("has no legs for an empty work list", () => {
    expect(groupByOrg([])).toEqual([]);
  });
});
