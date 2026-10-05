import { describe, expect, it } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityGate, errorBackoffMs, runInvalidator } from "./invalidator";

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

  it("keeps polling from the same cursor after failed polls", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    const refreshed: string[] = [];
    const script: Array<Page | Error> = [
      { entries: [], cursor: "7", hasMore: false },
      new Error("502"),
      new Error("502"),
      { entries: [{ parent: "d" }], cursor: "8", hasMore: false },
    ];
    await runInvalidator({
      changes: async (since) => {
        seen.push(since);
        const next = script.shift();
        if (!next) {
          ac.abort();
          return { entries: [], cursor: since, hasMore: false };
        }
        if (next instanceof Error) throw next;
        return next;
      },
      refresh: async (dir) => {
        refreshed.push(dir);
      },
      signal: ac.signal,
      pollMs: 0,
    });
    expect(seen.slice(0, 4)).toEqual(["0", "7", "7", "7"]);
    expect(refreshed).toEqual(["d"]);
  });
});

describe("errorBackoffMs", () => {
  it("grows from the poll floor and stays within equal-jitter bounds", () => {
    for (let failures = 1; failures <= 4; failures++) {
      const full = 1000 * 2 ** (failures - 1);
      const delay = errorBackoffMs(failures, 1000);
      expect(delay).toBeGreaterThanOrEqual(full / 2);
      expect(delay).toBeLessThanOrEqual(full);
    }
  });

  it("caps at 30s however long the outage lasts", () => {
    const delay = errorBackoffMs(50, 1000);
    expect(delay).toBeGreaterThanOrEqual(15_000);
    expect(delay).toBeLessThanOrEqual(30_000);
  });
});

describe("activityGate", () => {
  it("passes on a missing or fresh stamp and holds on a stale one until it is touched", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "orgfs-gate-")), "activity");
    const gate = activityGate(path, 60_000, 5);
    const signal = new AbortController().signal;

    await gate(signal); // no stamp: an older daemon, treated as in use

    writeFileSync(path, "");
    const stale = (Date.now() - 120_000) / 1000;
    utimesSync(path, stale, stale);
    let passed = false;
    const held = gate(signal).then(() => {
      passed = true;
    });
    await Bun.sleep(30);
    expect(passed).toBe(false);

    const now = Date.now() / 1000;
    utimesSync(path, now, now);
    await held;
    expect(passed).toBe(true);
  });
});
