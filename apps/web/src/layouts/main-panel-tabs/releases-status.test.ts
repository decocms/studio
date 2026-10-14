import { describe, expect, test } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import type { ReleaseCommit, ReleasesPage } from "./releases-api";
import {
  GOING_LIVE_WINDOW_MS,
  canRepublish,
  releaseBadge,
  releaseTitle,
  waitingForSite,
} from "./releases-status";

const t: TFunction = (key, vars) => interpolate(en[key], vars);
const tPt: TFunction = (key, vars) => interpolate(ptBR[key], vars);

const OLD = "a".repeat(40);
const LIVE = "b".repeat(40);
const NEW = "c".repeat(40);
const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const pointer = (revision: string, publishedAgo = 0) => ({
  revision,
  schemaHash: "h",
  publishedAt: ago(publishedAgo),
});

type State = Pick<ReleasesPage, "current" | "serving">;

describe("releaseBadge: Live is what the site reports", () => {
  test("the release the site serves is Live; the one just published is Going live…", () => {
    const state: State = {
      current: pointer(NEW, 30_000),
      serving: { source: "site", revision: LIVE, lastSeen: ago(5_000) },
    };
    expect(releaseBadge(LIVE, state, NOW)).toEqual({
      kind: "live",
      hint: null,
    });
    expect(releaseBadge(NEW, state, NOW)).toEqual({
      kind: "goingLive",
      hint: "goingLiveHint",
    });
    expect(releaseBadge(OLD, state, NOW)).toBeNull();
    expect(waitingForSite(state, NOW)).toBe(true);
  });

  test("once the site reports it, the new release is Live and nothing waits", () => {
    const state: State = {
      current: pointer(NEW, 60_000),
      serving: { source: "site", revision: NEW, lastSeen: ago(1_000) },
    };
    expect(releaseBadge(NEW, state, NOW)).toEqual({ kind: "live", hint: null });
    expect(releaseBadge(LIVE, state, NOW)).toBeNull();
    expect(waitingForSite(state, NOW)).toBe(false);
  });

  test("a release the site never confirms stops Going live… after the window: Published", () => {
    const state: State = {
      current: pointer(NEW, GOING_LIVE_WINDOW_MS + 1),
      serving: { source: "site", revision: LIVE, lastSeen: ago(1_000) },
    };
    expect(releaseBadge(NEW, state, NOW)).toEqual({
      kind: "published",
      hint: "notReportedHint",
    });
    expect(waitingForSite(state, NOW)).toBe(false);
  });

  test("no signal from the site: Live follows the last publish, with a hint", () => {
    const state: State = {
      current: pointer(NEW, 30_000),
      serving: { source: "none" },
    };
    expect(releaseBadge(NEW, state, NOW)).toEqual({
      kind: "live",
      hint: "liveHint",
    });
    expect(releaseBadge(LIVE, state, NOW)).toBeNull();
    // Recently published: it keeps asking, in case the site reports it.
    expect(waitingForSite(state, NOW)).toBe(true);
    expect(
      waitingForSite(
        { ...state, current: pointer(NEW, GOING_LIVE_WINDOW_MS + 1) },
        NOW,
      ),
    ).toBe(false);
  });

  test("nothing published: no badge, nothing to wait for", () => {
    const state: State = { current: null, serving: { source: "none" } };
    expect(releaseBadge(OLD, state, NOW)).toBeNull();
    expect(waitingForSite(state, NOW)).toBe(false);
  });
});

const commit = (
  sha: string,
  over: Partial<ReleaseCommit> = {},
): ReleaseCommit => ({
  sha,
  date: ago(0),
  message: "Summer sale",
  author: "Ana",
  hasRelease: true,
  republishOf: null,
  ...over,
});

describe("canRepublish", () => {
  const state: State = {
    current: pointer(NEW),
    serving: { source: "site", revision: LIVE, lastSeen: ago(0) },
  };
  test("an earlier release can be republished", () => {
    expect(canRepublish(commit(OLD), state)).toBe(true);
  });
  test("not the one the site shows, nor the one just published, nor a commit without a release", () => {
    expect(canRepublish(commit(LIVE), state)).toBe(false);
    expect(canRepublish(commit(NEW), state)).toBe(false);
    expect(canRepublish(commit(OLD, { hasRelease: false }), state)).toBe(false);
  });
});

describe("releaseTitle", () => {
  test("a note is shown as written", () => {
    expect(releaseTitle(t, commit(OLD), "en")).toBe("Summer sale");
  });
  test("a republish is labeled in the viewer's language", () => {
    const republished = commit(NEW, {
      message: "Republish: Summer sale",
      republishOf: { sha: OLD },
    });
    expect(releaseTitle(t, republished, "en")).toBe("Republish: Summer sale");
    expect(releaseTitle(tPt, republished, "pt-BR")).toBe(
      "Republicação: Summer sale",
    );
  });
  test("a republish of a release without a note names its date", () => {
    const republished = commit(NEW, {
      message: "Republish: release from 2026-10-01 09:30 UTC",
    });
    expect(releaseTitle(t, republished, "en")).toMatch(
      /^Republish of the release from Oct 1, 2026/,
    );
    expect(releaseTitle(tPt, republished, "pt-BR")).toMatch(
      /^Republicação da release de 1 de out\. de 2026/,
    );
  });
  test("developer words never show: a release without a note, a developer push", () => {
    expect(
      releaseTitle(
        t,
        commit(OLD, { message: "chore(decofile): update Home" }),
        "en",
      ),
    ).toBe("Published changes");
    expect(
      releaseTitle(
        t,
        commit(OLD, { message: "fix: build", hasRelease: false }),
        "en",
      ),
    ).toBe("Site update");
  });
});
