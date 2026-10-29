import { describe, expect, it } from "bun:test";
import {
  briefAgeDays,
  briefDay,
  briefPath,
  ORG_BRIEF_DIR,
  parseBriefFilename,
  personalBriefDir,
  pickBrief,
} from "./daily-brief";

const TODAY = "2026-10-28";

describe("brief paths", () => {
  it("puts the org brief and a member's brief in their folders", () => {
    expect(briefPath(ORG_BRIEF_DIR, TODAY)).toBe("brief/2026-10-28.html");
    expect(briefPath(personalBriefDir("user_a"), TODAY)).toBe(
      "users/user_a/brief/2026-10-28.html",
    );
  });

  it("names the day in local time", () => {
    expect(briefDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("parseBriefFilename", () => {
  it("reads a dated html file", () => {
    expect(parseBriefFilename("2026-10-28.html")).toBe("2026-10-28");
  });

  it("ignores names outside the convention", () => {
    for (const name of [
      "notes.html",
      "2026-10-28.htm",
      "2026-10-28.md",
      "2026-10-28",
      "2026-1-28.html",
      "2026-02-30.html",
      "2026-13-01.html",
      "draft-2026-10-28.html",
      "2026-10-28.html.bak",
      "",
    ]) {
      expect(parseBriefFilename(name)).toBeNull();
    }
  });
});

describe("pickBrief", () => {
  it("picks today's brief over older ones", () => {
    expect(
      pickBrief(["2026-10-26.html", TODAY + ".html", "2026-10-27.html"], TODAY),
    ).toEqual({ name: "2026-10-28.html", day: TODAY });
  });

  it("falls back to the newest older brief", () => {
    expect(pickBrief(["2026-10-20.html", "2026-10-25.html"], TODAY)).toEqual({
      name: "2026-10-25.html",
      day: "2026-10-25",
    });
  });

  it("drops briefs a week old or older", () => {
    expect(pickBrief(["2026-10-22.html"], TODAY)).toEqual({
      name: "2026-10-22.html",
      day: "2026-10-22",
    });
    expect(pickBrief(["2026-10-21.html", "2026-09-01.html"], TODAY)).toBeNull();
  });

  it("crosses month and year boundaries when counting the week", () => {
    expect(pickBrief(["2025-12-27.html"], "2026-01-02")?.day).toBe(
      "2025-12-27",
    );
    expect(pickBrief(["2025-12-26.html"], "2026-01-02")).toBeNull();
  });

  it("skips briefs dated in the future", () => {
    expect(
      pickBrief(
        ["2026-10-29.html", "2027-01-01.html", "2026-10-27.html"],
        TODAY,
      ),
    ).toEqual({ name: "2026-10-27.html", day: "2026-10-27" });
    expect(pickBrief(["2026-10-29.html"], TODAY)).toBeNull();
  });

  it("skips invalid names", () => {
    expect(
      pickBrief(["latest.html", "9999-99-99.html", "2026-10-24.html"], TODAY),
    ).toEqual({ name: "2026-10-24.html", day: "2026-10-24" });
    expect(pickBrief(["latest.html", "README.md"], TODAY)).toBeNull();
  });

  it("returns null for an empty folder", () => {
    expect(pickBrief([], TODAY)).toBeNull();
  });
});

describe("briefAgeDays", () => {
  it("counts whole days back from today", () => {
    expect(briefAgeDays(TODAY, TODAY)).toBe(0);
    expect(briefAgeDays("2026-10-27", TODAY)).toBe(1);
    expect(briefAgeDays("2026-09-28", TODAY)).toBe(30);
    expect(briefAgeDays("2025-10-28", TODAY)).toBe(365);
  });
});
