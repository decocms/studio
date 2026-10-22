import { describe, expect, it } from "bun:test";
import { namedRuleUses } from "@/components/sections-editor/named-rule-uses";
import {
  campaignRows,
  campaignStatus,
  removedCampaigns,
  timelineBar,
  timelineLabelPlacement,
  timelineStart,
} from "./campaigns-model";

const at = (iso: string) => new Date(iso);

describe("campaignStatus", () => {
  const window = {
    start: "2026-11-27T00:00:00-03:00",
    end: "2026-12-01T00:00:00-03:00",
  };

  it("runs from its start (inclusive) to its end (exclusive)", () => {
    expect(campaignStatus(window, at("2026-11-27T02:59:59Z"))).toBe("upcoming");
    expect(campaignStatus(window, at("2026-11-27T03:00:00Z"))).toBe("running");
    expect(campaignStatus(window, at("2026-12-01T02:59:59Z"))).toBe("running");
    expect(campaignStatus(window, at("2026-12-01T03:00:00Z"))).toBe("ended");
  });

  it("treats a missing bound as open", () => {
    expect(campaignStatus({ start: window.start }, at("2030-01-01Z"))).toBe(
      "running",
    );
    expect(campaignStatus({ end: window.end }, at("2020-01-01Z"))).toBe(
      "running",
    );
    expect(campaignStatus({}, at("2026-01-01Z"))).toBe("always");
  });

  it("says when a date can't be read, since the site never runs it", () => {
    expect(campaignStatus({ start: "soon" }, at("2026-01-01Z"))).toBe(
      "unreadable",
    );
  });
});

describe("campaignRows", () => {
  const now = at("2026-11-28T12:00:00Z");
  const published = {
    campaigns: {
      __resolveType: "calendar",
      "black-friday": {
        start: "2026-11-27T00:00:00-03:00",
        end: "2026-12-01T00:00:00-03:00",
      },
      gone: { start: "2025-01-01T00:00:00Z" },
    },
  };
  const draft = {
    campaigns: {
      __resolveType: "calendar",
      summer: { start: "2025-01-01T00:00:00Z", end: "2025-03-01T00:00:00Z" },
      christmas: {
        start: "2026-12-20T00:00:00-03:00",
        end: "2026-12-26T00:00:00-03:00",
      },
      newyear: { start: "2026-12-31T00:00:00-03:00" },
      "black-friday": {
        start: "2026-11-27T00:00:00-03:00",
        end: "2026-12-02T00:00:00-03:00",
      },
      always: {},
      broken: { end: "later" },
    },
    "pages-home-1": {
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: {
        __resolveType: "multivariate",
        variants: [
          {
            rule: { __resolveType: "campaign", name: "christmas" },
            value: { __resolveType: "lazy", value: [] },
          },
        ],
      },
    },
  };

  it("orders running, upcoming (soonest first), always, unreadable, then ended", () => {
    const uses = namedRuleUses({
      decofile: draft,
      changeCount: 2,
      sides: {
        campaigns: {
          kind: "set",
          before: published.campaigns,
          after: draft.campaigns,
          version: "v2",
          baseVersion: "v1",
        },
        "pages-home-1": {
          kind: "set",
          before: null,
          after: draft["pages-home-1"],
          version: "p1",
          baseVersion: null,
        },
      },
    });
    const rows = campaignRows(draft, uses, now);
    expect(rows.map((r) => [r.name, r.status, r.entryState, r.uses])).toEqual([
      ["black-friday", "running", "changed", 0],
      ["christmas", "upcoming", "new", 1],
      ["newyear", "upcoming", "new", 0],
      ["always", "always", "new", 0],
      ["broken", "unreadable", "new", 0],
      ["summer", "ended", "new", 0],
    ]);
    expect(rows[0]!.publishedWindow).toEqual(
      published.campaigns["black-friday"],
    );
    expect(removedCampaigns(draft, uses)).toEqual(["gone"]);
  });
});

describe("timelineBar", () => {
  const from = at("2026-11-01T00:00:00Z");
  const to = at("2027-03-01T00:00:00Z");

  it("places a window inside the range", () => {
    const bar = timelineBar(
      { start: "2026-12-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
      from,
      to,
    )!;
    expect(bar.openStart).toBe(false);
    expect(bar.openEnd).toBe(false);
    expect(bar.left).toBeCloseTo((30 / 120) * 100, 5);
    expect(bar.width).toBeCloseTo((31 / 120) * 100, 5);
  });

  it("runs an open or longer window to the edge and says so", () => {
    expect(timelineBar({}, from, to)).toEqual({
      left: 0,
      width: 100,
      openStart: true,
      openEnd: true,
    });
    const bar = timelineBar({ start: "2027-02-01T00:00:00Z" }, from, to)!;
    expect(bar.openEnd).toBe(true);
    expect(bar.left + bar.width).toBeCloseTo(100, 5);
  });

  it("has no bar outside the range, or for dates it can't read", () => {
    expect(timelineBar({ end: "2026-10-01T00:00:00Z" }, from, to)).toBeNull();
    expect(timelineBar({ start: "2027-03-01T00:00:00Z" }, from, to)).toBeNull();
    expect(timelineBar({ start: "nope" }, from, to)).toBeNull();
  });
});

describe("timelineLabelPlacement", () => {
  const from = at("2026-11-01T00:00:00Z");
  const to = at("2027-03-01T00:00:00Z");

  it("a month-long campaign carries its name", () => {
    const bar = timelineBar(
      { start: "2026-11-27T00:00:00Z", end: "2026-12-27T00:00:00Z" },
      from,
      to,
    )!;
    expect(timelineLabelPlacement(bar, "Black Friday")).toBe("inside");
  });

  it("a short campaign's name goes beside its bar, never cut", () => {
    // Two days on a four-month range: a few pixels.
    const bar = timelineBar(
      { start: "2026-11-27T00:00:00Z", end: "2026-11-29T00:00:00Z" },
      from,
      to,
    )!;
    expect(timelineLabelPlacement(bar, "b")).toBe("after");
    expect(timelineLabelPlacement(bar, "Black Friday")).toBe("after");
  });

  it("before the bar when it ends near the right edge", () => {
    const bar = timelineBar(
      { start: "2027-02-25T00:00:00Z", end: "2027-02-27T00:00:00Z" },
      from,
      to,
    )!;
    expect(timelineLabelPlacement(bar, "Carnival sale")).toBe("before");
  });

  it("after it when there is room on neither side", () => {
    expect(timelineLabelPlacement({ left: 0, width: 1 }, "x".repeat(80))).toBe(
      "after",
    );
  });
});

describe("timelineStart", () => {
  const now = new Date(2026, 9, 22, 12);
  const month = (y: number, m: number) => new Date(y, m, 1).getTime();

  it("opens on this month when something shows there", () => {
    expect(
      timelineStart(
        [{ start: new Date(2026, 10, 27).toISOString() }],
        now,
        4,
      ).getTime(),
    ).toBe(month(2026, 9));
    expect(timelineStart([], now, 4).getTime()).toBe(month(2026, 9));
  });

  it("opens on the next campaign's month when nothing shows before it", () => {
    const windows = [
      {
        start: new Date(2027, 5, 10).toISOString(),
        end: new Date(2027, 5, 12).toISOString(),
      },
      { start: new Date(2027, 2, 3).toISOString() },
      { end: new Date(2026, 0, 1).toISOString() },
    ];
    expect(timelineStart(windows, now, 4).getTime()).toBe(month(2027, 2));
  });
});
