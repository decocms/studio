import { describe, expect, test } from "bun:test";
import {
  FIXED_SYSTEM_TABS,
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatAgentViewTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
} from "./tab-id";
import {
  canonicalThreadRouteTarget,
  tabIdForRoute,
  tabRouteLocation,
  tabRouteTarget,
} from "./tab-route";

describe("tabRouteLocation", () => {
  test("nests every Site Editor view under the Site Editor route", () => {
    expect(tabRouteLocation("preview")).toEqual({
      kind: "site-editor",
      view: "preview",
    });
    expect(tabRouteLocation("site-editor")).toEqual({
      kind: "site-editor",
      view: "preview",
    });
    expect(tabRouteLocation("content")).toEqual({
      kind: "site-editor",
      view: "content",
    });
    expect(tabRouteLocation("code")).toEqual({
      kind: "site-editor",
      view: "code",
    });
    expect(tabRouteLocation(formatCodeTabId("src/app.tsx"))).toEqual({
      kind: "site-editor",
      view: "code",
      file: "src/app.tsx",
    });
  });

  test("represents dynamic agent views with typed route payloads", () => {
    expect(
      tabRouteLocation(formatPinnedViewTabId("conn-one", "GET/orders")),
    ).toEqual({
      kind: "app",
      connectionId: "conn-one",
      toolName: "GET/orders",
    });
    expect(tabRouteLocation("automation:auto-1")).toEqual({
      kind: "automations",
      automationId: "auto-1",
    });
    expect(tabRouteLocation("my-custom-view")).toEqual({
      kind: "agent-view",
      viewId: "my-custom-view",
    });
    for (const id of ["reports", "git", "content", "app:conn:tool"]) {
      expect(tabRouteLocation(formatAgentViewTabId(id))).toEqual({
        kind: "agent-view",
        viewId: id,
      });
    }
  });

  test("keeps opaque output paths out of route segments", () => {
    expect(
      tabRouteLocation(formatFileTabId("org-fs:outputs/t/a b.pdf")),
    ).toEqual({ kind: "output-file", key: "org-fs:outputs/t/a b.pdf" });
    expect(tabRouteLocation(formatDeckTabId("decks/q3 launch.html"))).toEqual({
      kind: "output-deck",
      path: "decks/q3 launch.html",
    });
    expect(
      tabRouteLocation(formatLibraryFileTabId("home/docs/spec final.md")),
    ).toEqual({ kind: "library-file", path: "home/docs/spec final.md" });
  });

  test("separates project destinations from the organization Library", () => {
    expect(tabRouteLocation("board")).toEqual({
      kind: "project-destination",
      destination: "tasks",
    });
    expect(tabRouteLocation("files")).toEqual({
      kind: "org-destination",
      destination: "library",
    });
    expect(tabRouteLocation("reports")).toEqual({
      kind: "project-destination",
      destination: "reports",
    });
  });

  test("retires persisted Discover tabs to organization Home", () => {
    expect(tabRouteLocation("discover")).toEqual({
      kind: "org-destination",
      destination: "home",
    });
    expect(
      tabRouteTarget({ org: "acme", agentId: "vir_1", tabId: "discover" }),
    ).toEqual({
      to: "/$org/home",
      params: { org: "acme" },
      search: {},
    });
  });

  test("normalizes retired built-in names but leaves unknown ids intact", () => {
    for (const tab of ["instructions", "connections", "layout", "settings"]) {
      expect(tabRouteLocation(tab)).toEqual({
        kind: "agent-section",
        section: "settings",
      });
    }
    expect(tabRouteLocation("cdn")).toEqual({
      kind: "agent-section",
      section: "monitor",
    });
  });

  test("routes every built-in explicitly instead of treating it as metadata", () => {
    for (const tabId of FIXED_SYSTEM_TABS) {
      expect(tabRouteLocation(tabId).kind).not.toBe("agent-view");
    }
  });
});

describe("tabRouteTarget", () => {
  const base = { org: "acme", agentId: "vir_1" };

  test("puts agent identity in every agent-owned path", () => {
    expect(tabRouteTarget({ ...base, tabId: "site-editor" })).toEqual({
      to: "/$org/projects/$agentId/site-editor",
      params: base,
      search: {},
    });
    expect(tabRouteTarget({ ...base, tabId: "settings" })).toEqual({
      to: "/$org/projects/$agentId/settings",
      params: base,
      search: {},
    });
  });

  test("puts dynamic identity in params and opaque paths in search", () => {
    expect(
      tabRouteTarget({
        ...base,
        tabId: formatPinnedViewTabId("conn_1", "GET_ORDERS"),
      }),
    ).toEqual({
      to: "/$org/projects/$agentId/apps/$connectionId/$toolName",
      params: { ...base, connectionId: "conn_1", toolName: "GET_ORDERS" },
      search: {},
    });
    expect(
      tabRouteTarget({ ...base, tabId: formatCodeTabId("src/a.tsx") }),
    ).toEqual({
      to: "/$org/projects/$agentId/site-editor/code",
      params: base,
      search: { file: "src/a.tsx" },
    });
  });

  test("keeps declared ids in the agent-view namespace despite collisions", () => {
    for (const viewId of ["reports", "git", "content", "app:conn:tool"]) {
      expect(
        tabRouteTarget({
          ...base,
          tabId: formatAgentViewTabId(viewId),
        }),
      ).toEqual({
        to: "/$org/projects/$agentId/views/$viewId",
        params: { ...base, viewId },
        search: {},
      });
    }
  });

  test("project destinations keep project identity in their path", () => {
    expect(tabRouteTarget({ ...base, tabId: "board" })).toEqual({
      to: "/$org/projects/$agentId/tasks/{-$taskKey}",
      params: { ...base, taskKey: undefined },
      search: {},
    });
    expect(tabRouteTarget({ ...base, tabId: "reports" })).toEqual({
      to: "/$org/projects/$agentId/reports",
      params: base,
      search: {},
    });
  });

  test("organization context keeps shared destinations outside a project", () => {
    expect(
      tabRouteTarget({
        ...base,
        tabId: "board",
        destinationScope: "organization",
      }),
    ).toEqual({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: "acme", taskKey: undefined },
      search: {},
    });
    expect(
      tabRouteTarget({
        ...base,
        tabId: "reports",
        destinationScope: "organization",
      }),
    ).toEqual({
      to: "/$org/reports",
      params: { org: "acme" },
      search: {},
    });
  });
});

describe("canonicalThreadRouteTarget", () => {
  const base = { org: "acme", superAgentId: "decopilot_org-1" };

  test("routes a project-to-Super switch to organization Home", () => {
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: base.superAgentId,
        tabId: "overview",
      }),
    ).toEqual({
      to: "/$org/home",
      params: { org: "acme" },
      search: {},
    });
  });

  test("keeps an explicit Super Agent view on its agent route", () => {
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: base.superAgentId,
        tabId: "settings",
      }),
    ).toEqual({
      to: "/$org/projects/$agentId/settings",
      params: { org: "acme", agentId: base.superAgentId },
      search: {},
    });
  });

  test("keeps shared Super Agent destinations at organization scope", () => {
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: base.superAgentId,
        tabId: "board",
      }),
    ).toEqual({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: "acme", taskKey: undefined },
      search: {},
    });
  });

  test("routes a Home-to-Super switch back to organization Home", () => {
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: base.superAgentId,
      }),
    ).toEqual({
      to: "/$org/home",
      params: { org: "acme" },
      search: {},
    });
  });

  test("keeps a destination with no agent on organization Home", () => {
    expect(canonicalThreadRouteTarget(base)).toEqual({
      to: "/$org/home",
      params: { org: "acme" },
      search: {},
    });
  });

  test("routes a regular agent to its overview or requested view", () => {
    expect(
      canonicalThreadRouteTarget({ ...base, agentId: "agent-1" }),
    ).toMatchObject({
      to: "/$org/projects/$agentId",
      params: { org: "acme", agentId: "agent-1" },
    });
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: "agent-1",
        tabId: "settings",
      }),
    ).toMatchObject({
      to: "/$org/projects/$agentId/settings",
      params: { org: "acme", agentId: "agent-1" },
    });
  });

  test("keeps project destinations and sanitizes organization-only destinations", () => {
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: "agent-1",
        tabId: "board",
      }),
    ).toMatchObject({
      to: "/$org/projects/$agentId/tasks/{-$taskKey}",
      params: { org: "acme", agentId: "agent-1" },
    });
    expect(
      canonicalThreadRouteTarget({
        ...base,
        agentId: "agent-1",
        tabId: "reports",
      }),
    ).toMatchObject({
      to: "/$org/projects/$agentId/reports",
      params: { org: "acme", agentId: "agent-1" },
    });

    for (const tabId of ["files", "discover"]) {
      expect(
        canonicalThreadRouteTarget({
          ...base,
          agentId: "agent-1",
          tabId,
        }),
      ).toMatchObject({
        to: "/$org/projects/$agentId",
        params: { org: "acme", agentId: "agent-1" },
      });
    }
  });
});

describe("tabIdForRoute", () => {
  test("reconstructs nested and parameterized route ids", () => {
    expect(
      tabIdForRoute({
        mainView: "code",
        siteEditorView: "code",
        search: { file: "src/a.tsx" },
      }),
    ).toBe(formatCodeTabId("src/a.tsx"));
    expect(
      tabIdForRoute({
        mainView: "app",
        params: { connectionId: "conn_1", toolName: "GET_ORDERS" },
      }),
    ).toBe(formatPinnedViewTabId("conn_1", "GET_ORDERS"));
    expect(
      tabIdForRoute({
        mainView: "automation",
        params: { automationId: "auto-1" },
      }),
    ).toBe("automation:auto-1");
  });

  test("reconstructs a namespaced agent-view id even when it is built-in-shaped", () => {
    expect(
      tabIdForRoute({ mainView: "view", params: { viewId: "reports" } }),
    ).toBe(formatAgentViewTabId("reports"));
  });

  test("rejects truncated dynamic routes instead of inventing a tab", () => {
    expect(tabIdForRoute({ mainView: "app" })).toBeUndefined();
    expect(tabIdForRoute({ mainView: "file" })).toBeUndefined();
    expect(tabIdForRoute({ mainView: "view" })).toBeUndefined();
  });
});
