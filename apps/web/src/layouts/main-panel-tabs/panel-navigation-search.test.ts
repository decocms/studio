import { describe, expect, test } from "bun:test";
import { resolvePanelNavigationSearch } from "./panel-navigation-search";

describe("resolvePanelNavigationSearch", () => {
  test("carries only shell-owned thread state between agent child routes", () => {
    expect(
      resolvePanelNavigationSearch({
        previous: {
          thread: "thread-1",
          sidepanel: false,
          autosend: "true",
          mainpanel: false,
          file: "src/old.tsx",
          key: "org-fs:outputs/thread-1/old.pdf",
          path: "home/old.md",
          connection: "conn-old",
          tool: "OLD_TOOL",
          automation: "automation-old",
          contentPageId: "page-old",
          contentPath: "/old",
          contentPathTemplate: "/:slug",
          preview: "home/preview.md",
          virtualmcpid: "stale-agent",
          main: "content",
        },
        destination: "agent",
      }),
    ).toEqual({
      thread: "thread-1",
      sidepanel: false,
      autosend: "true",
      mainpanel: undefined,
    });
  });

  test("retires thread hand-off state when opening an organization destination", () => {
    expect(
      resolvePanelNavigationSearch({
        previous: {
          thread: "thread-1",
          sidepanel: true,
          autosend: "true",
        },
        destination: "organization",
      }),
    ).toEqual({
      thread: undefined,
      sidepanel: true,
      autosend: undefined,
      mainpanel: undefined,
    });
  });

  test("applies an explicit destination update without exposing prior route payload", () => {
    expect(
      resolvePanelNavigationSearch({
        previous: {
          thread: "thread-1",
          sidepanel: true,
          autosend: "true",
          file: "src/old.tsx",
        },
        destination: "agent",
        update: (shared) => ({ ...shared, sidepanel: false, file: undefined }),
      }),
    ).toEqual({
      thread: "thread-1",
      sidepanel: false,
      autosend: "true",
      file: undefined,
      mainpanel: undefined,
    });
  });
});
