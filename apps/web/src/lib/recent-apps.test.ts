import { describe, expect, test } from "bun:test";
import { pushRecentApp, type RecentApp } from "./recent-apps";

const entry = (app: string, projectId: string): RecentApp => ({
  app,
  projectId,
  projectTitle: `${projectId} title`,
});

describe("pushRecentApp", () => {
  test("puts the app just opened first", () => {
    const list = pushRecentApp([entry("hosting", "p1")], entry("assets", "p1"));
    expect(list.map((it) => it.app)).toEqual(["assets", "hosting"]);
  });

  test("reopening moves the entry instead of duplicating it", () => {
    const list = pushRecentApp(
      [entry("hosting", "p1"), entry("assets", "p1")],
      entry("assets", "p1"),
    );
    expect(list.map((it) => it.app)).toEqual(["assets", "hosting"]);
  });

  test("the same app in two projects are two entries", () => {
    const list = pushRecentApp(
      [entry("hosting", "p1")],
      entry("hosting", "p2"),
    );
    expect(list.map((it) => it.projectId)).toEqual(["p2", "p1"]);
  });

  test("keeps a renamed project's newest title", () => {
    const list = pushRecentApp([entry("hosting", "p1")], {
      app: "hosting",
      projectId: "p1",
      projectTitle: "Renamed",
    });
    expect(list).toEqual([
      { app: "hosting", projectId: "p1", projectTitle: "Renamed" },
    ]);
  });

  test("drops the oldest past the limit", () => {
    const list = ["a", "b", "c", "d", "e"].reduce<RecentApp[]>(
      (acc, app) => pushRecentApp(acc, entry(app, "p1")),
      [],
    );
    expect(list.map((it) => it.app)).toEqual(["e", "d", "c", "b"]);
  });
});
