import { describe, expect, it } from "bun:test";
import { DEFAULT_SCHEDULE_HOUR, type PostMeta } from "./blog-data";
import {
  dayKey,
  entryDay,
  groupPostsByDay,
  parsePostDay,
  rescheduleToDay,
  scheduledPostPayload,
} from "./post-calendar-data";

function post(overrides: Partial<PostMeta> = {}): PostMeta {
  return {
    key: "collections/blog/posts/a",
    title: "A post",
    slug: "a-post",
    date: "",
    scheduledDatetime: "",
    categorySlugs: [],
    authorEmails: [],
    missing: [],
    status: "published",
    ...overrides,
  };
}

describe("dayKey", () => {
  it("zero-pads month and day", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("parsePostDay", () => {
  it("reads a bare date as the local calendar day, not UTC midnight", () => {
    const day = parsePostDay("2026-08-21");
    expect(day).not.toBeNull();
    // The whole point: west of UTC, `new Date("2026-08-21")` would be Aug 20.
    expect(day?.getFullYear()).toBe(2026);
    expect(day?.getMonth()).toBe(7);
    expect(day?.getDate()).toBe(21);
    expect(day?.getHours()).toBe(0);
  });

  it("maps a full ISO timestamp to the local day it falls on", () => {
    const instant = new Date(2026, 7, 21, 15, 30);
    const day = parsePostDay(instant.toISOString());
    expect(dayKey(day!)).toBe("2026-08-21");
  });

  it("tolerates surrounding whitespace", () => {
    expect(dayKey(parsePostDay("  2026-08-21  ")!)).toBe("2026-08-21");
  });

  it("returns null for an empty or whitespace-only date", () => {
    expect(parsePostDay("")).toBeNull();
    expect(parsePostDay("   ")).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(parsePostDay("not a date")).toBeNull();
  });

  it("returns null for a bare date that doesn't exist", () => {
    expect(parsePostDay("2026-02-31")).toBeNull();
    expect(parsePostDay("2026-13-01")).toBeNull();
  });

  it("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(dayKey(parsePostDay("2024-02-29")!)).toBe("2024-02-29");
    expect(parsePostDay("2026-02-29")).toBeNull();
  });
});

describe("entryDay", () => {
  it("prefers the scheduled instant over the editorial date", () => {
    const day = entryDay(
      post({ date: "2026-08-21", scheduledDatetime: "2026-09-02T09:00:00Z" }),
    );
    expect(dayKey(day!)).toBe(
      dayKey(new Date(Date.parse("2026-09-02T09:00:00Z"))),
    );
  });

  it("falls back to the editorial date when there is no schedule", () => {
    expect(dayKey(entryDay(post({ date: "2026-08-21" }))!)).toBe("2026-08-21");
  });

  it("falls back to the editorial date when the schedule is malformed", () => {
    const day = entryDay(
      post({ date: "2026-08-21", scheduledDatetime: "whenever" }),
    );
    expect(dayKey(day!)).toBe("2026-08-21");
  });

  it("is null when neither date is usable", () => {
    expect(entryDay(post({ date: "", scheduledDatetime: "" }))).toBeNull();
  });
});

describe("scheduledPostPayload", () => {
  it("schedules the new post at the default hour on the clicked day", () => {
    const payload = scheduledPostPayload(new Date(2026, 8, 2));
    const goLive = new Date(payload.scheduledDatetime as string);
    expect(payload.status).toBe("scheduled");
    expect(goLive.getFullYear()).toBe(2026);
    expect(goLive.getMonth()).toBe(8);
    expect(goLive.getDate()).toBe(2);
    expect(goLive.getHours()).toBe(DEFAULT_SCHEDULE_HOUR);
  });

  it("sets the editorial date to the same day, not today", () => {
    expect(scheduledPostPayload(new Date(2026, 8, 2)).date).toBe("2026-09-02");
  });

  it("lands on the day it was created for", () => {
    const day = new Date(2026, 8, 2);
    const payload = scheduledPostPayload(day);
    const { byDay } = groupPostsByDay([
      post({
        date: payload.date as string,
        scheduledDatetime: payload.scheduledDatetime as string,
      }),
    ]);
    expect(byDay.get(dayKey(day))?.[0]?.scheduled).toBe(true);
  });

  it("keeps the empty-post defaults it builds on", () => {
    const payload = scheduledPostPayload(new Date(2026, 8, 2));
    expect(payload.title).toBe("Untitled post");
    expect(payload.sections).toEqual([]);
  });
});

describe("rescheduleToDay", () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0) =>
    new Date(y, m, d, h, min).toISOString();

  it("keeps the time of day when moving to another day", () => {
    const next = rescheduleToDay(
      { scheduledDatetime: at(2026, 7, 21, 14, 30) },
      new Date(2026, 7, 24),
    );
    const moved = new Date(next!.scheduledDatetime as string);
    expect(dayKey(moved)).toBe("2026-08-24");
    expect(moved.getHours()).toBe(14);
    expect(moved.getMinutes()).toBe(30);
  });

  it("moves the editorial date along when it still matched the schedule", () => {
    const next = rescheduleToDay(
      { date: "2026-08-21", scheduledDatetime: at(2026, 7, 21, 8) },
      new Date(2026, 7, 24),
    );
    expect(next!.date).toBe("2026-08-24");
  });

  it("leaves an editorial date the user pulled apart alone", () => {
    const next = rescheduleToDay(
      { date: "2026-01-15", scheduledDatetime: at(2026, 7, 21, 8) },
      new Date(2026, 7, 24),
    );
    expect(next!.date).toBe("2026-01-15");
  });

  it("leaves an absent editorial date absent", () => {
    const next = rescheduleToDay(
      { scheduledDatetime: at(2026, 7, 21, 8) },
      new Date(2026, 7, 24),
    );
    expect(next!.date).toBeUndefined();
  });

  it("refuses to move a post with no usable schedule", () => {
    const day = new Date(2026, 7, 24);
    expect(rescheduleToDay({ date: "2026-08-21" }, day)).toBeNull();
    expect(rescheduleToDay({ scheduledDatetime: "" }, day)).toBeNull();
    expect(rescheduleToDay({ scheduledDatetime: "whenever" }, day)).toBeNull();
    expect(rescheduleToDay({ scheduledDatetime: 42 }, day)).toBeNull();
  });

  it("is a no-op landing on the day the post already sits on", () => {
    const iso = at(2026, 7, 21, 8);
    const next = rescheduleToDay(
      { scheduledDatetime: iso },
      new Date(2026, 7, 21),
    );
    expect(next!.scheduledDatetime).toBe(iso);
  });

  it("preserves every other field and never mutates the input", () => {
    const post = {
      title: "Hello",
      sections: [],
      scheduledDatetime: at(2026, 7, 21, 8),
    };
    const next = rescheduleToDay(post, new Date(2026, 7, 24));
    expect(next!.title).toBe("Hello");
    expect(next!.sections).toBe(post.sections);
    expect(post.scheduledDatetime).toBe(at(2026, 7, 21, 8));
  });
});

describe("groupPostsByDay", () => {
  it("buckets posts by local day", () => {
    const { byDay, undated } = groupPostsByDay([
      post({ key: "a", title: "Alpha", date: "2026-08-21" }),
      post({ key: "b", title: "Bravo", date: "2026-08-21" }),
      post({ key: "c", title: "Charlie", date: "2026-08-22" }),
    ]);
    expect(undated).toEqual([]);
    expect(byDay.get("2026-08-21")?.map((e) => e.post.key)).toEqual(["a", "b"]);
    expect(byDay.get("2026-08-22")?.map((e) => e.post.key)).toEqual(["c"]);
  });

  it("flags posts placed by their editorial date as not scheduled", () => {
    const { byDay } = groupPostsByDay([post({ key: "a", date: "2026-08-21" })]);
    expect(byDay.get("2026-08-21")?.[0]?.scheduled).toBe(false);
  });

  it("flags posts carrying a scheduled instant as scheduled", () => {
    const scheduled = new Date(2026, 7, 21, 9).toISOString();
    const { byDay } = groupPostsByDay([
      post({ key: "a", date: "2026-01-01", scheduledDatetime: scheduled }),
    ]);
    expect(byDay.get("2026-08-21")?.[0]?.scheduled).toBe(true);
    expect(byDay.has("2026-01-01")).toBe(false);
  });

  it("sorts scheduled posts ahead of unscheduled ones on the same day", () => {
    const scheduled = new Date(2026, 7, 21, 9).toISOString();
    const { byDay } = groupPostsByDay([
      post({ key: "alpha", title: "Alpha", date: "2026-08-21" }),
      post({ key: "zulu", title: "Zulu", scheduledDatetime: scheduled }),
    ]);
    expect(byDay.get("2026-08-21")?.map((e) => e.post.key)).toEqual([
      "zulu",
      "alpha",
    ]);
  });

  it("orders posts within a day by title, not decofile order", () => {
    const { byDay } = groupPostsByDay([
      post({ key: "z", title: "Zulu", date: "2026-08-21" }),
      post({ key: "a", title: "Alpha", date: "2026-08-21" }),
    ]);
    expect(byDay.get("2026-08-21")?.map((e) => e.post.title)).toEqual([
      "Alpha",
      "Zulu",
    ]);
  });

  it("collects dateless and malformed posts in the undated tray", () => {
    const { byDay, undated } = groupPostsByDay([
      post({ key: "none", title: "No date", date: "" }),
      post({ key: "bad", title: "Bad date", date: "whenever" }),
      post({ key: "ok", title: "Dated", date: "2026-08-21" }),
    ]);
    expect(undated.map((e) => e.post.key)).toEqual(["bad", "none"]);
    expect(byDay.size).toBe(1);
  });

  it("returns empty structures for no posts", () => {
    const { byDay, undated } = groupPostsByDay([]);
    expect(byDay.size).toBe(0);
    expect(undated).toEqual([]);
  });
});
