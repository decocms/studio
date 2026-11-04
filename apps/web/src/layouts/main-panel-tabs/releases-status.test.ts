import { describe, expect, test } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { interpolate } from "@/i18n/interpolate.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import type { ReleaseRevision, ReleaseStatus } from "./releases-api";
import {
  canPreviewRelease,
  canReapply,
  isLatest,
  listedRevisions,
  releaseTitle,
  revisionTime,
} from "./releases-status";

const t: TFunction = (key, vars) => interpolate(en[key], vars);
const tPt: TFunction = (key, vars) => interpolate(ptBR[key], vars);

/** The design's example id; its UUIDv7 says 2024-12-07T16:27:18.400Z. */
const OLD = "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55";
const NEW = "fe6c5e0da3ee-0193a1f2-5c11-7d02-8b4e-2f6a9c1d3e77";

const revision = (
  id: string,
  status: ReleaseStatus,
  meta: Partial<ReleaseRevision["meta"]> = {},
): ReleaseRevision => ({
  id,
  status,
  meta: {
    previous: null,
    author: "usr_1",
    via: "studio",
    message: "Summer sale",
    publishedAt: "2026-10-14T12:00:00Z",
    ...meta,
  },
});

describe("Latest is the revision latest.json names", () => {
  test("only the current row is Latest", () => {
    expect(isLatest(revision(NEW, "current"))).toBe(true);
    expect(isLatest(revision(OLD, "was-live"))).toBe(false);
  });

  test("a revision latest.json never named isn't listed", () => {
    expect(
      listedRevisions([
        revision(NEW, "current"),
        revision(OLD, "never-live"),
      ]).map((r) => r.id),
    ).toEqual([NEW]);
  });
});

describe("canPreviewRelease", () => {
  test("any listed release can be previewed, the latest too", () => {
    expect(canPreviewRelease(revision(OLD, "was-live"))).toBe(true);
    expect(canPreviewRelease(revision(NEW, "current"))).toBe(true);
  });
  test("not a revision that never went live, nor a git sha", () => {
    expect(canPreviewRelease(revision(OLD, "never-live"))).toBe(false);
    expect(canPreviewRelease(revision("a".repeat(40), "was-live"))).toBe(false);
  });
});

describe("canReapply", () => {
  test("an earlier release that went live can be made current", () => {
    expect(canReapply(revision(OLD, "was-live"))).toBe(true);
  });
  test("not the latest one, nor one that never went live", () => {
    expect(canReapply(revision(NEW, "current"))).toBe(false);
    expect(canReapply(revision(OLD, "never-live"))).toBe(false);
  });
});

describe("revisionTime", () => {
  test("reads the UUIDv7's timestamp", () => {
    expect(revisionTime(OLD)?.toISOString()).toBe("2024-12-07T16:27:18.400Z");
    expect(revisionTime("not-an-id")).toBeNull();
  });
});

describe("releaseTitle", () => {
  test("a note is shown as written", () => {
    expect(releaseTitle(t, { message: "Summer sale" }, "en")).toBe(
      "Summer sale",
    );
  });
  test("a release made current is labeled in the viewer's language", () => {
    for (const message of [
      "Made current: Summer sale",
      "Reapply: Summer sale",
    ]) {
      expect(releaseTitle(t, { message }, "en")).toBe(
        "Made current: Summer sale",
      );
      expect(releaseTitle(tPt, { message }, "pt-BR")).toBe(
        "Tornada atual: Summer sale",
      );
    }
  });
  test("making current a release without a note names its date", () => {
    for (const message of [
      "Made current: release from 2026-10-01 09:30 UTC",
      "Reapply: release from 2026-10-01 09:30 UTC",
      "Reapply: version from 2026-10-01 09:30 UTC",
    ]) {
      expect(releaseTitle(t, { message }, "en")).toMatch(
        /^Made current: release from Oct 1, 2026/,
      );
      expect(releaseTitle(tPt, { message }, "pt-BR")).toMatch(
        /^Tornada atual: release de 1 de out\. de 2026/,
      );
    }
    for (const message of [
      "Made current: earlier release",
      "Reapply: earlier release",
      "Reapply: earlier version",
    ]) {
      expect(releaseTitle(t, { message }, "en")).toBe(
        "Made current: Published changes",
      );
    }
  });
  test("developer words never show: a release without a note", () => {
    expect(
      releaseTitle(t, { message: "chore(decofile): update Home" }, "en"),
    ).toBe("Published changes");
    expect(releaseTitle(t, { message: "" }, "en")).toBe("Published changes");
  });
});
