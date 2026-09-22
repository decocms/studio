import { describe, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import {
  CHOICE_PAGE_SIZE,
  coversSelection,
  delegableRepositories,
  FlowAccessCache,
  pageChoices,
  provesNothingDelegable,
  remainingPages,
  type RepositoryChoice,
} from "./connect-access";

function repo(id: number, admin?: boolean) {
  return {
    id,
    full_name: `acme/repo-${id}`,
    ...(admin === undefined ? {} : { permissions: { admin } }),
  };
}

function choices(count: number, prefix = "acme/repo-"): RepositoryChoice[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `${prefix}${i + 1}`,
  }));
}

describe("delegableRepositories", () => {
  test("keeps only repositories the user administers, in order", () => {
    expect(
      delegableRepositories({
        repositories: [repo(1, true), repo(2, false), repo(3), repo(4, true)],
      }),
    ).toEqual([
      { id: 1, name: "acme/repo-1" },
      { id: 4, name: "acme/repo-4" },
    ]);
  });
});

describe("remainingPages", () => {
  test("derives the page count from total_count", () => {
    expect(remainingPages({ total_count: 0, repositories: [] })).toBe(0);
    expect(remainingPages({ total_count: 100, repositories: [] })).toBe(0);
    expect(remainingPages({ total_count: 101, repositories: [] })).toBe(1);
    expect(remainingPages({ total_count: 450, repositories: [] })).toBe(4);
  });

  test("is unknown without total_count", () => {
    expect(remainingPages({ repositories: [] })).toBe(-1);
  });
});

describe("provesNothingDelegable", () => {
  test("a complete page with no admin repository proves it", () => {
    expect(
      provesNothingDelegable({
        total_count: 2,
        repositories: [repo(1, false), repo(2)],
      }),
    ).toBe(true);
  });

  test("a partial page or an unknown total defers to the picker", () => {
    expect(
      provesNothingDelegable({
        total_count: 150,
        repositories: Array.from({ length: CHOICE_PAGE_SIZE }, (_, i) =>
          repo(i + 1, false),
        ),
      }),
    ).toBe(false);
    expect(provesNothingDelegable({ repositories: [repo(1, false)] })).toBe(
      false,
    );
  });

  test("one admin repository is enough to list the account", () => {
    expect(
      provesNothingDelegable({
        total_count: 2,
        repositories: [repo(1, false), repo(2, true)],
      }),
    ).toBe(false);
  });
});

describe("pageChoices", () => {
  test("pages the whole list a hundred at a time", () => {
    const all = choices(250);
    const first = pageChoices(all, 1);
    expect(first.repositories).toHaveLength(100);
    expect(first.repositories[0]).toEqual({ id: 1, name: "acme/repo-1" });
    expect(first.hasMore).toBe(true);
    const last = pageChoices(all, 3);
    expect(last.repositories).toHaveLength(50);
    expect(last.hasMore).toBe(false);
    expect(pageChoices(all, 4)).toEqual({ repositories: [], hasMore: false });
  });

  test("searches every repository, not the requested page", () => {
    const all = [...choices(120), { id: 999, name: "acme/needle" }];
    expect(pageChoices(all, 1, "needle")).toEqual({
      repositories: [{ id: 999, name: "acme/needle" }],
      hasMore: false,
    });
    expect(pageChoices(all, 1, "NEEDLE").repositories).toHaveLength(1);
  });

  test("hasMore follows the matches, so no match means no more", () => {
    const all = choices(250);
    expect(pageChoices(all, 1, "absent")).toEqual({
      repositories: [],
      hasMore: false,
    });
    const wide = pageChoices(all, 1, "repo-1");
    // repo-1, repo-10..19, repo-100..199: 111 matches.
    expect(wide.repositories).toHaveLength(100);
    expect(wide.hasMore).toBe(true);
    expect(pageChoices(all, 2, "repo-1").repositories).toHaveLength(11);
  });
});

describe("coversSelection", () => {
  test("every selected id must be delegable", () => {
    const all = choices(3);
    expect(coversSelection(all, [1, 3])).toBe(true);
    expect(coversSelection(all, [1, 4])).toBe(false);
    expect(coversSelection([], [])).toBe(true);
  });
});

describe("FlowAccessCache", () => {
  test("remembers per flow and per installation until forgotten", () => {
    const cache = new FlowAccessCache(60_000);
    const installations = [
      {
        installationId: 7,
        externalAccountId: "1",
        login: "acme",
        avatarUrl: null,
        accountType: "Organization",
        htmlUrl: null,
      },
    ];
    cache.rememberInstallations("flow-a", installations);
    cache.rememberRepositories("flow-a", 7, choices(2));
    cache.rememberRepositories("flow-a", 8, choices(1));
    expect(cache.installations("flow-a")).toBe(installations);
    expect(cache.repositories("flow-a", 7)).toHaveLength(2);
    expect(cache.repositories("flow-a", 8)).toHaveLength(1);
    expect(cache.repositories("flow-a", 9)).toBeUndefined();
    expect(cache.installations("flow-b")).toBeUndefined();
    cache.forget("flow-a");
    expect(cache.installations("flow-a")).toBeUndefined();
    expect(cache.repositories("flow-a", 7)).toBeUndefined();
  });

  test("entries expire with the flow", async () => {
    const cache = new FlowAccessCache(1);
    cache.rememberRepositories("flow-a", 7, choices(2));
    await sleep(5);
    expect(cache.repositories("flow-a", 7)).toBeUndefined();
  });
});
