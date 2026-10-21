import { describe, expect, test } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import type { ReleaseCommit } from "./releases-api";
import {
  canPreviewRelease,
  canReapply,
  isLatest,
  latestSha,
  releaseTitle,
} from "./releases-status";

const t: TFunction = (key, vars) => interpolate(en[key], vars);
const tPt: TFunction = (key, vars) => interpolate(ptBR[key], vars);

const OLD = "a".repeat(40);
const NEW = "c".repeat(40);
const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const pointer = (revision: string) => ({
  revision,
  schemaHash: "h",
  publishedAt: ago(0),
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
  reapplyOf: null,
  ...over,
});

describe("Latest is the version latest.json names", () => {
  test("only that row is Latest; nothing is before the first publish", () => {
    expect(isLatest(NEW, pointer(NEW))).toBe(true);
    expect(isLatest(OLD, pointer(NEW))).toBe(false);
    expect(isLatest(OLD, null)).toBe(false);
    expect(latestSha({ current: pointer(NEW) })).toBe(NEW);
    expect(latestSha({ current: null })).toBeNull();
    expect(latestSha(undefined)).toBeNull();
  });
});

describe("canPreviewRelease", () => {
  test("any version with a release can be previewed, the latest too", () => {
    expect(canPreviewRelease(commit(OLD))).toBe(true);
    expect(canPreviewRelease(commit(NEW))).toBe(true);
  });
  test("not a commit without a release", () => {
    expect(canPreviewRelease(commit(OLD, { hasRelease: false }))).toBe(false);
  });
});

describe("canReapply", () => {
  test("an earlier version can be reapplied", () => {
    expect(canReapply(commit(OLD), pointer(NEW))).toBe(true);
    expect(canReapply(commit(OLD), null)).toBe(true);
  });
  test("not the latest one, nor a commit without a release", () => {
    expect(canReapply(commit(NEW), pointer(NEW))).toBe(false);
    expect(canReapply(commit(OLD, { hasRelease: false }), pointer(NEW))).toBe(
      false,
    );
  });
});

describe("releaseTitle", () => {
  test("a note is shown as written", () => {
    expect(releaseTitle(t, commit(OLD), "en")).toBe("Summer sale");
  });
  test("a reapplied version is labeled in the viewer's language", () => {
    const reapplied = commit(NEW, {
      message: "Reapply: Summer sale",
      reapplyOf: { sha: OLD, date: null },
    });
    expect(releaseTitle(t, reapplied, "en")).toBe("Reapply: Summer sale");
    expect(releaseTitle(tPt, reapplied, "pt-BR")).toBe(
      "Reaplicação: Summer sale",
    );
  });
  test("reapplying a release without a note names its date", () => {
    for (const message of [
      "Reapply: release from 2026-10-01 09:30 UTC",
      // A note the server wrote before it said "release".
      "Reapply: version from 2026-10-01 09:30 UTC",
    ]) {
      const reapplied = commit(NEW, { message });
      expect(releaseTitle(t, reapplied, "en")).toMatch(
        /^Reapply: release from Oct 1, 2026/,
      );
      expect(releaseTitle(tPt, reapplied, "pt-BR")).toMatch(
        /^Reaplicação da release de 1 de out\. de 2026/,
      );
    }
    for (const message of [
      "Reapply: earlier release",
      "Reapply: earlier version",
    ]) {
      expect(releaseTitle(t, commit(NEW, { message }), "en")).toBe(
        "Reapply: Published changes",
      );
    }
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
