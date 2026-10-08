import { describe, expect, test } from "bun:test";
import {
  appOpenKey,
  dropRecentApp,
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

describe("dropRecentApp", () => {
  test("closes only that app in that project", () => {
    const list = [
      entry("hosting", "p1"),
      entry("hosting", "p2"),
      entry("assets", "p1"),
    ];
    expect(dropRecentApp(list, { app: "hosting", projectId: "p1" })).toEqual([
      entry("hosting", "p2"),
      entry("assets", "p1"),
    ]);
  });

  test("closing an app that is not there changes nothing", () => {
    const list = [entry("hosting", "p1")];
    expect(dropRecentApp(list, { app: "assets", projectId: "p1" })).toEqual(
      list,
    );
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
  const connectionApp = (id: string, toolName: string) =>
    `app:${id}:${toolName}`;
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
        connectionApp,
      ),
    ).toEqual({ app: "assets", projectId: "p1" });
  });

  test("a project's Site Editor tabs are all the Site Editor", () => {
    for (const [mainView, siteEditorView] of [
      ["site-editor", "preview"],
      ["content", "content"],
      ["code", "code"],
    ] as const) {
      expect(
        openAppOf(
          [match({ mainView, siteEditorView }, { agentId: "p1" })],
          isApp,
          connectionApp,
        ),
      ).toEqual({ app: "site-editor", projectId: "p1" });
    }
  });

  test("a connection's app is that pinned view in that project", () => {
    expect(
      openAppOf(
        [
          match(
            { mainView: "app" },
            { agentId: "p1", connectionId: "conn_1", toolName: "open" },
          ),
        ],
        isApp,
        connectionApp,
      ),
    ).toEqual({
      app: "app:conn_1:open",
      projectId: "p1",
      connection: { id: "conn_1", toolName: "open" },
    });
  });

  test("every account-less /site-editor tab is the Site Editor", () => {
    for (const [mainView, siteEditorView] of [
      ["site-editor", "preview"],
      ["content", "content"],
      ["code", "code"],
    ] as const) {
      expect(
        openAppOf(
          [match({ mainView, siteEditorView, local: true })],
          isApp,
          connectionApp,
        ),
      ).toEqual({ app: "site-editor", projectId: null });
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
        connectionApp,
      ),
    ).toEqual({ app: "site-editor", projectId: null });
  });

  test("an org-level route with no project is no open app", () => {
    expect(
      openAppOf([match({ mainView: "reports" }, {})], isApp, connectionApp),
    ).toBeNull();
  });

  test("a place, not an app, is no open app", () => {
    expect(
      openAppOf(
        [match({ mainView: "board" }, { agentId: "p1" })],
        isApp,
        connectionApp,
      ),
    ).toBeNull();
    expect(openAppOf([match({})], isApp, connectionApp)).toBeNull();
  });
});
