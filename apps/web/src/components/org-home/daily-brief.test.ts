import { describe, expect, it } from "bun:test";
import { briefsToShow } from "./daily-brief";

const TODAY = "2026-10-28";
const USER = "user_a";

const file = (path: string) => ({ path, kind: "file" as const, size: 10 });

describe("briefsToShow", () => {
  it("puts the member's brief above the org's", () => {
    const briefs = briefsToShow({
      userId: USER,
      personal: [file(`users/${USER}/brief/2026-10-28.html`)],
      org: [file("brief/2026-10-27.html"), file("brief/2026-10-28.html")],
      today: TODAY,
    });
    expect(briefs).toEqual([
      {
        scope: "personal",
        path: `users/${USER}/brief/2026-10-28.html`,
        filename: "2026-10-28.html",
        size: 10,
        day: TODAY,
        ageDays: 0,
      },
      {
        scope: "org",
        path: "brief/2026-10-28.html",
        filename: "2026-10-28.html",
        size: 10,
        day: TODAY,
        ageDays: 0,
      },
    ]);
  });

  it("shows only the member's brief when the org has none", () => {
    const briefs = briefsToShow({
      userId: USER,
      personal: [file(`users/${USER}/brief/2026-10-25.html`)],
      org: [file("brief/notes.html"), file("brief/2026-10-30.html")],
      today: TODAY,
    });
    expect(briefs.map((b) => [b.scope, b.day, b.ageDays])).toEqual([
      ["personal", "2026-10-25", 3],
    ]);
  });

  it("shows only the org's brief when the member has none", () => {
    const briefs = briefsToShow({
      userId: USER,
      personal: [],
      org: [file("brief/2026-10-27.html")],
      today: TODAY,
    });
    expect(briefs.map((b) => [b.scope, b.ageDays])).toEqual([["org", 1]]);
  });

  it("drops a folder whose newest brief is a week old", () => {
    const briefs = briefsToShow({
      userId: USER,
      personal: [file(`users/${USER}/brief/2026-10-21.html`)],
      org: [file("brief/2026-10-22.html")],
      today: TODAY,
    });
    expect(briefs.map((b) => [b.scope, b.ageDays])).toEqual([["org", 6]]);
  });

  it("ignores folders named like a brief", () => {
    const briefs = briefsToShow({
      userId: USER,
      personal: [],
      org: [{ path: "brief/2026-10-28.html", kind: "dir", size: 0 }],
      today: TODAY,
    });
    expect(briefs).toEqual([]);
  });

  it("shows nothing without briefs, or without a signed-in member", () => {
    expect(
      briefsToShow({ userId: USER, personal: [], org: [], today: TODAY }),
    ).toEqual([]);
    expect(
      briefsToShow({
        userId: undefined,
        personal: [file("users/undefined/brief/2026-10-28.html")],
        org: [],
        today: TODAY,
      }),
    ).toEqual([]);
  });
});
