/**
 * A BrowserPort for tests: each page answers `evaluate` by the function it is
 * handed (the page scripts are matched by identity), and the test decides what
 * a navigation does. Nothing runs a real page.
 */

import { wallSnapshotInPage } from "../page-scripts.ts";
import type { BrowserPage, BrowserPort } from "../ports.ts";
import type { UxDevice } from "../types.ts";

type Handler = (...args: unknown[]) => unknown;

export interface FakePageSpec {
  /** What `goto` resolves with; a function sees the target. */
  goto?: (url: string) => {
    status?: number | null;
    error?: string | null;
    landsOn?: string;
  };
  /** Page scripts by identity; an unknown one resolves undefined. */
  scripts?: Map<unknown, Handler>;
  /** Anything else: e.g. `() => document.contentType` is matched by source. */
  fallback?: (fn: unknown, args: unknown[]) => unknown;
  blocked?: number;
}

export interface FakeBrowser {
  browser: BrowserPort;
  /** Every URL a page navigated to, in order. */
  visited: string[];
  /** The `blockRequest` each page was opened with. */
  blockers: Array<((url: string) => boolean) | undefined>;
  devices: UxDevice[];
}

export function fakeBrowser(
  spec: (pageIndex: number) => FakePageSpec,
  fetch: BrowserPort["fetch"] = async () => {
    throw new TypeError("no network in tests");
  },
): FakeBrowser {
  const visited: string[] = [];
  const blockers: FakeBrowser["blockers"] = [];
  const devices: UxDevice[] = [];
  let pages = 0;
  const browser: BrowserPort = {
    async newPage(device, opts) {
      const s = spec(pages++);
      blockers.push(opts?.blockRequest);
      devices.push(device);
      let current = "about:blank";
      const page: BrowserPage = {
        viewport:
          device === "mobile"
            ? { width: 390, height: 844, deviceScaleFactor: 2 }
            : { width: 1440, height: 900, deviceScaleFactor: 1 },
        url: () => current,
        async goto(url) {
          visited.push(url);
          const r = s.goto?.(url) ?? {};
          current = r.landsOn ?? url;
          return { status: r.status ?? 200, error: r.error ?? null };
        },
        async reload() {},
        async evaluate<A extends unknown[], R>(
          fn: (...args: A) => R,
          ...args: A
        ): Promise<Awaited<R>> {
          const handler = s.scripts?.get(fn);
          const value = handler
            ? await handler(...args)
            : (s.fallback?.(fn, args) ?? defaultAnswer(fn));
          return value as Awaited<R>;
        },
        async screenshot() {
          return new Uint8Array([0xff, 0xd8, 0xff]);
        },
        async mouseMove() {},
        async click() {
          return { navigation: null };
        },
        blockedRequests: () => s.blocked ?? 0,
        async close() {},
      };
      return page;
    },
    fetch,
  };
  return { browser, visited, blockers, devices };
}

/** A store page that opened: HTML, no anti-bot wall. */
function defaultAnswer(fn: unknown): unknown {
  if (fn === wallSnapshotInPage) return { links: 50, html: "", text: "" };
  if (String(fn).includes("contentType")) return "text/html";
  return undefined;
}
