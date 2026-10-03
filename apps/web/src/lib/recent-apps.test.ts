import { describe, expect, test } from "bun:test";
import {
  appOpenKey,
  openAppOf,
  pushAppOpen,
  pushRecentApp,
  type RecentApp,
} from "./recent-apps";

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

describe("pushAppOpen", () => {
  test("newest first, one entry per app and project", () => {
    const a = appOpenKey("p1", "hosting");
    const b = appOpenKey("p2", "app:conn_1:open");
    expect(pushAppOpen(pushAppOpen([a], b), a)).toEqual([a, b]);
  });

  test("the same app in two projects is two entries", () => {
    const p1 = appOpenKey("p1", "hosting");
    const p2 = appOpenKey("p2", "hosting");
    expect(pushAppOpen(pushAppOpen([], p1), p2)).toEqual([p2, p1]);
  });

  test("a key cannot collide across the project and app boundary", () => {
    expect(appOpenKey("a|b", "c")).not.toBe(appOpenKey("a", "b|c"));
  });

  test("drops the oldest past the limit", () => {
    expect(pushAppOpen(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("openAppOf", () => {
  const isApp = (app: string) =>
    ["site-editor", "assets", "reports"].includes(app);
  const match = (
    staticData: {
      mainView?: string;
      siteEditorView?: "preview" | "content" | "code";
      local?: boolean;
    },
    params?: Record<string, string>,
  ) => ({ staticData, params });

  test("a project's app route is that app in that project", () => {
    expect(
      openAppOf(
        [match({}), match({ mainView: "assets" }, { agentId: "p1" })],
        isApp,
      ),
    ).toEqual({ app: "assets", projectId: "p1" });
  });

  test("every Site Editor tab is the Site Editor", () => {
    for (const [mainView, siteEditorView] of [
      ["site-editor", "preview"],
      ["content", "content"],
      ["code", "code"],
    ] as const) {
      expect(
        openAppOf(
          [match({ mainView, siteEditorView }, { agentId: "p1" })],
          isApp,
        ),
      ).toEqual({ app: "site-editor", projectId: "p1" });
    }
  });

  test("the account-less /site-editor is the Site Editor, with no project", () => {
    expect(
      openAppOf(
        [
          match({}),
          match({
            mainView: "content",
            siteEditorView: "content",
            local: true,
          }),
        ],
        isApp,
      ),
    ).toEqual({ app: "site-editor", projectId: null });
  });

  test("an org-level route with no project is no open app", () => {
    expect(openAppOf([match({ mainView: "reports" }, {})], isApp)).toBeNull();
  });

  test("a place, not an app, is no open app", () => {
    expect(
      openAppOf([match({ mainView: "board" }, { agentId: "p1" })], isApp),
    ).toBeNull();
    expect(openAppOf([match({})], isApp)).toBeNull();
  });
});
