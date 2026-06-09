import { describe, expect, it } from "bun:test";
import { runInvalidator } from "./invalidator";

type Page = { entries: { parent: string }[]; cursor: string; hasMore: boolean };

/**
 * Drives runInvalidator over a scripted sequence of change-feed pages, then
 * aborts once the script is exhausted. Returns the dirs passed to refresh().
 */
async function drive(pages: Page[]) {
  const ac = new AbortController();
  const refreshed: string[] = [];
  const seen: string[] = []; // cursors requested, in order
  let i = 0;
  await runInvalidator({
    changes: async (since) => {
      seen.push(since);
      if (i < pages.length) return pages[i++]!;
      ac.abort(); // script done — stop the loop after this empty tail
      return { entries: [], cursor: since, hasMore: false };
    },
    refresh: async (dir) => {
      refreshed.push(dir);
    },
    signal: ac.signal,
    pollMs: 0,
  });
  return { refreshed, seen };
}

describe("runInvalidator", () => {
  it("primes to head without refreshing, then refreshes parents of new changes", async () => {
    const { refreshed } = await drive([
      // priming drain (hasMore=false ends priming) — must NOT refresh
      {
        entries: [{ parent: "" }, { parent: "a" }],
        cursor: "2",
        hasMore: false,
      },
      // a real post-prime change → refresh its parent dir
      { entries: [{ parent: "a/b" }], cursor: "3", hasMore: false },
    ]);
    expect(refreshed).toEqual(["a/b"]);
  });

  it("dedupes multiple changes in the same dir to one refresh", async () => {
    const { refreshed } = await drive([
      { entries: [], cursor: "0", hasMore: false }, // prime (empty)
      {
        entries: [{ parent: "x" }, { parent: "x" }, { parent: "y" }],
        cursor: "5",
        hasMore: false,
      },
    ]);
    expect(refreshed.sort()).toEqual(["x", "y"]);
  });

  it("advances the cursor across pages (no re-reading from 0)", async () => {
    const { seen } = await drive([
      { entries: [], cursor: "10", hasMore: false }, // prime → cursor 10
      { entries: [{ parent: "z" }], cursor: "11", hasMore: false },
    ]);
    // first poll from "0", then from the advanced cursors
    expect(seen.slice(0, 3)).toEqual(["0", "10", "11"]);
  });

  it("drains a multi-page backlog (hasMore) before refreshing new changes", async () => {
    const { refreshed } = await drive([
      // priming spans two pages (hasMore on the first)
      { entries: [{ parent: "old1" }], cursor: "1", hasMore: true },
      { entries: [{ parent: "old2" }], cursor: "2", hasMore: false },
      // only this post-prime change is refreshed
      { entries: [{ parent: "new" }], cursor: "3", hasMore: false },
    ]);
    expect(refreshed).toEqual(["new"]);
  });
});
