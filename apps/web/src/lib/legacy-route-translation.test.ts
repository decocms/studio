import { describe, expect, it } from "bun:test";
import {
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
} from "@/layouts/main-panel-tabs/tab-id";
import {
  type LegacyThreadSearch,
  agentWorkspacePathHasChild,
  isCanonicalAgentIdSegment,
  promoteLegacyTaskParam,
  resolveLegacyAgentId,
  retireLegacyAgentSearch,
  translateLegacyAgentPath,
  translateLegacyMainParam,
  translateLegacyOrgDestinationAgentSearch,
  translateLegacyPanelRoute,
  translateLegacyThreadRoute,
} from "./legacy-route-translation";

const ORG = "acme";
const THREAD = "thr_1";
const AGENT = "vir_abc";
const SUPER_AGENT = "decopilot_org_1";

describe("agentWorkspacePathHasChild", () => {
  it("does not mistake an organization named agents for a child route", () => {
    expect(agentWorkspacePathHasChild("/agents/agents/code")).toBe(false);
    expect(agentWorkspacePathHasChild("/agents/agents/code/")).toBe(false);
  });

  it("recognizes canonical children below the agent boundary", () => {
    expect(agentWorkspacePathHasChild("/acme/agents/vir_1/settings")).toBe(
      true,
    );
    expect(
      agentWorkspacePathHasChild("/agents/agents/code/site-editor/content"),
    ).toBe(true);
  });
});

describe("translateLegacyAgentPath", () => {
  it("uses the mounted org's Super Agent for an identity-less view", () => {
    expect(
      translateLegacyAgentPath({
        pathname: `/${ORG}/agents/settings`,
        org: ORG,
        pathAgentId: "settings",
        fallbackAgentId: SUPER_AGENT,
        search: {
          thread: THREAD,
          sidepanel: true,
        },
      }),
    ).toEqual({
      route: {
        to: "/$org/agents/$agentId/settings",
        params: { org: ORG, agentId: SUPER_AGENT },
        search: {},
      },
      search: { thread: THREAD, sidepanel: true },
    });
  });

  it("canonicalizes the panel before applying the retired closed-main state", () => {
    expect(
      translateLegacyAgentPath({
        pathname: `/${ORG}/agents/code`,
        org: ORG,
        pathAgentId: "code",
        fallbackAgentId: SUPER_AGENT,
        search: {
          main: 0,
          file: "src/a.tsx",
          thread: THREAD,
          sidepanel: true,
        },
      }),
    ).toEqual({
      route: {
        to: "/$org/agents/$agentId/site-editor/code",
        params: { org: ORG, agentId: SUPER_AGENT },
        search: { file: "src/a.tsx" },
      },
      search: {
        file: "src/a.tsx",
        thread: THREAD,
        sidepanel: true,
        mainpanel: false,
      },
    });
  });

  it("does not reinterpret canonical agent roots or their children", () => {
    expect(
      translateLegacyAgentPath({
        pathname: `/${ORG}/agents/${AGENT}`,
        org: ORG,
        pathAgentId: AGENT,
        fallbackAgentId: SUPER_AGENT,
        search: { virtualmcpid: "vir_stale" },
      }),
    ).toBeNull();
    expect(
      translateLegacyAgentPath({
        pathname: `/${ORG}/agents/${AGENT}/settings`,
        org: ORG,
        pathAgentId: AGENT,
        fallbackAgentId: SUPER_AGENT,
        search: {},
      }),
    ).toBeNull();
  });

  it("canonicalizes a project-first custom view directly", () => {
    expect(
      translateLegacyAgentPath({
        pathname: `/${ORG}/agents/${AGENT}/monitor`,
        org: ORG,
        pathAgentId: AGENT,
        pathLegacyView: "monitor",
        fallbackAgentId: SUPER_AGENT,
        search: {
          thread: THREAD,
        },
      }),
    ).toEqual({
      route: {
        to: "/$org/agents/$agentId/views/$viewId",
        params: { org: ORG, agentId: AGENT, viewId: "monitor" },
        search: {},
      },
      search: { thread: THREAD },
    });
  });

  it("lets explicit main override an opaque view-first path", () => {
    expect(
      translateLegacyAgentPath({
        pathname: `/${ORG}/agents/custom-dashboard`,
        org: ORG,
        pathAgentId: "custom-dashboard",
        fallbackAgentId: SUPER_AGENT,
        search: {
          virtualmcpid: AGENT,
          main: "settings",
          thread: THREAD,
        },
      }),
    ).toEqual({
      route: {
        to: "/$org/agents/$agentId/settings",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: { thread: THREAD },
    });
  });
});

const translateThread = (search?: LegacyThreadSearch | null) =>
  translateLegacyThreadRoute({
    org: ORG,
    taskId: THREAD,
    fallbackAgentId: SUPER_AGENT,
    search,
  });

const translateMain = (
  main: string | 0 | undefined,
  search: LegacyThreadSearch = {},
) =>
  translateLegacyMainParam({
    org: ORG,
    agentId: AGENT,
    main,
    search: { ...search, main },
  });

describe("translateLegacyThreadRoute", () => {
  it("lands an unscoped legacy thread on Home", () => {
    expect(translateThread()).toEqual({
      route: {
        to: "/$org/home",
        params: { org: ORG },
        search: {},
      },
      search: { thread: THREAD },
    });
    expect(translateThread(null)).toEqual(translateThread({}));
  });

  it("puts legacy query-carried agent identity in the canonical path", () => {
    expect(translateThread({ virtualmcpid: AGENT })).toEqual({
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: { thread: THREAD },
    });
    expect(translateThread({ virtualmcpid: "   " }).route.to).toBe(
      "/$org/home",
    );
  });

  it("moves every org-owned legacy main value directly to its page", () => {
    const rows = [
      ["board", "/$org/tasks/{-$taskKey}"],
      ["files", "/$org/library"],
      ["reports", "/$org/reports"],
      ["overview", "/$org/home"],
      ["discover", "/$org/discover"],
    ] as const;

    for (const [main, to] of rows) {
      const target = translateThread({
        main,
        virtualmcpid: AGENT,
        sidepanel: false,
      });
      expect(target.route.to).toBe(to);
      expect(target.search).toEqual({ sidepanel: false, thread: THREAD });
    }
  });

  it("carries a legacy Library folder into its canonical route", () => {
    expect(
      translateThread({
        main: "files",
        virtualmcpid: AGENT,
        path: "home/docs",
      }),
    ).toEqual({
      route: {
        to: "/$org/library",
        params: { org: ORG },
        search: { path: "home/docs" },
      },
      search: { path: "home/docs", thread: THREAD },
    });
  });

  it("maps fixed agent views to their canonical route owners", () => {
    const rows = [
      ["preview", "/$org/agents/$agentId/site-editor"],
      ["site-editor", "/$org/agents/$agentId/site-editor"],
      ["content", "/$org/agents/$agentId/site-editor/content"],
      ["code", "/$org/agents/$agentId/site-editor/code"],
      ["settings", "/$org/agents/$agentId/settings"],
      ["instructions", "/$org/agents/$agentId/settings"],
      ["connections", "/$org/agents/$agentId/settings"],
      ["layout", "/$org/agents/$agentId/settings"],
      ["automations", "/$org/agents/$agentId/automations"],
      ["assets", "/$org/agents/$agentId/assets"],
      ["git", "/$org/agents/$agentId/git"],
      ["hosting", "/$org/agents/$agentId/hosting"],
      ["e2e", "/$org/agents/$agentId/e2e"],
      ["analytics", "/$org/agents/$agentId/analytics"],
      ["cdn", "/$org/agents/$agentId/cdn"],
      ["connect-sources", "/$org/agents/$agentId/connect-sources"],
    ] as const;

    for (const [main, to] of rows) {
      const target = translateThread({ main, virtualmcpid: AGENT });
      expect(target.route.to).toBe(to);
      expect(target.search.thread).toBe(THREAD);
      expect("main" in target.search).toBe(false);
      expect("virtualmcpid" in target.search).toBe(false);
    }
  });

  it("maps parameterized and custom main values without a legacy hop", () => {
    const rows = [
      [
        formatCodeTabId("src/app.tsx"),
        "/$org/agents/$agentId/site-editor/code",
        { file: "src/app.tsx" },
      ],
      [
        "automation:auto_1",
        "/$org/agents/$agentId/automations/$automationId",
        {},
      ],
      [
        formatPinnedViewTabId("conn_1", "get_orders"),
        "/$org/agents/$agentId/apps/$connectionId/$toolName",
        {},
      ],
      [
        formatFileTabId("org-fs:outputs/thr/a.pdf"),
        "/$org/agents/$agentId/outputs/file",
        { key: "org-fs:outputs/thr/a.pdf" },
      ],
      [
        formatDeckTabId("decks/q3.html"),
        "/$org/agents/$agentId/outputs/deck",
        { path: "decks/q3.html" },
      ],
      [
        formatLibraryFileTabId("home/docs/a.md"),
        "/$org/agents/$agentId/library/file",
        { path: "home/docs/a.md" },
      ],
      ["custom-view", "/$org/agents/$agentId/views/$viewId", {}],
    ] as const;

    for (const [main, to, routeSearch] of rows) {
      const target = translateThread({ main, virtualmcpid: AGENT });
      expect(target.route.to).toBe(to);
      expect(target.route.search).toEqual(routeSearch);
      expect(target.search).toEqual({ ...routeSearch, thread: THREAD });
    }
  });

  it("uses the Super Agent for a named view that predates agent identity", () => {
    expect(translateThread({ main: "settings" })).toEqual({
      route: {
        to: "/$org/agents/$agentId/settings",
        params: { org: ORG, agentId: SUPER_AGENT },
        search: {},
      },
      search: { thread: THREAD },
    });
  });

  it("turns the closed sentinel into layout state on the canonical base", () => {
    expect(translateThread({ main: 0, virtualmcpid: AGENT })).toEqual({
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: { mainpanel: false, thread: THREAD },
    });
    expect(translateThread({ main: "0" })).toEqual({
      route: {
        to: "/$org/home",
        params: { org: ORG },
        search: {},
      },
      search: { mainpanel: false, thread: THREAD },
    });
  });

  it("treats main=chat as the retired no-main state", () => {
    expect(translateThread({ main: "chat", virtualmcpid: AGENT })).toEqual({
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: {
        sidepanel: true,
        mainpanel: false,
        thread: THREAD,
      },
    });
    expect(translateThread({ main: "chat" }).route.to).toBe("/$org/home");
  });

  it("preserves non-routing search and retires every legacy routing key", () => {
    const target = translateThread({
      main: formatCodeTabId("src/new.ts"),
      virtualmcpid: AGENT,
      file: "src/stale.ts",
      key: "stale-key",
      deck: "stale-deck",
      path: "stale-path",
      connection: "stale-connection",
      tool: "stale-tool",
      automation: "stale-automation",
      sidepanel: false,
      autosend: "hello",
    });

    expect(target.search).toEqual({
      sidepanel: false,
      autosend: "hello",
      file: "src/new.ts",
      thread: THREAD,
    });
  });

  it("hands a board card deep link to the tasks route", () => {
    expect(translateThread({ main: "board", task: "DECO-01" })).toEqual({
      route: {
        to: "/$org/tasks/{-$taskKey}",
        params: { org: ORG, taskKey: undefined },
        search: {},
      },
      search: { task: "DECO-01", thread: THREAD },
    });
  });
});

describe("translateLegacyMainParam", () => {
  it("leaves a URL without legacy main state alone", () => {
    expect(translateMain(undefined)).toBeNull();
  });

  it("keeps main=0 on the current page and preserves its other state", () => {
    expect(
      translateMain(0, {
        virtualmcpid: AGENT,
        file: "src/a.tsx",
        sidepanel: true,
      }),
    ).toEqual({
      kind: "same-route",
      search: {
        virtualmcpid: AGENT,
        file: "src/a.tsx",
        sidepanel: true,
        mainpanel: false,
      },
    });
  });

  it("moves Site Editor children to nested routes", () => {
    expect(translateMain("preview")).toMatchObject({
      kind: "canonical",
      route: { to: "/$org/agents/$agentId/site-editor" },
    });
    expect(translateMain("content")).toMatchObject({
      kind: "canonical",
      route: { to: "/$org/agents/$agentId/site-editor/content" },
    });
    expect(translateMain("code")).toMatchObject({
      kind: "canonical",
      route: { to: "/$org/agents/$agentId/site-editor/code" },
    });
  });

  it("re-homes a legacy Library path instead of discarding it", () => {
    expect(
      translateMain("files", {
        path: "home/docs",
        sidepanel: true,
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/library",
        params: { org: ORG },
        search: { path: "home/docs" },
      },
      search: { path: "home/docs", sidepanel: true },
    });
  });

  it("keeps canonical path identity authoritative over stale query identity", () => {
    const target = translateLegacyMainParam({
      org: ORG,
      agentId: "agent-from-path",
      main: "settings",
      search: {
        main: "settings",
        virtualmcpid: "different-stale-agent",
      },
    });
    expect(target).toMatchObject({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId/settings",
        params: { org: ORG, agentId: "agent-from-path" },
      },
      search: {},
    });
  });

  it("does not turn the retired chat default into a custom view", () => {
    expect(translateMain("chat")).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: { sidepanel: true, mainpanel: false },
    });
  });

  it("lands malformed bare parameterized kinds on the agent root", () => {
    for (const main of ["app", "file", "deck", "library-file"]) {
      expect(translateMain(main)).toMatchObject({
        kind: "canonical",
        route: { to: "/$org/agents/$agentId" },
      });
    }
  });

  it("requires identity only for agent-owned views", () => {
    expect(
      translateLegacyMainParam({ org: ORG, main: "code", search: {} }),
    ).toBeNull();
    expect(
      translateLegacyMainParam({ org: ORG, main: "board", search: {} }),
    ).toMatchObject({
      kind: "canonical",
      route: { to: "/$org/tasks/{-$taskKey}" },
    });
  });
});

describe("translateLegacyPanelRoute", () => {
  it("maps old view-first panel URLs directly to canonical paths", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "code",
        search: { virtualmcpid: AGENT, file: "src/a.tsx", sidepanel: true },
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId/site-editor/code",
        params: { org: ORG, agentId: AGENT },
        search: { file: "src/a.tsx" },
      },
      search: { sidepanel: true, file: "src/a.tsx" },
    });
  });

  it("preserves the folder owned by an old Library panel URL", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "files",
        search: { virtualmcpid: AGENT, path: "home/docs" },
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/library",
        params: { org: ORG },
        search: { path: "home/docs" },
      },
      search: { path: "home/docs" },
    });
  });

  it("maps old app and automation payloads into route params", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "app",
        search: { connection: "conn_1", tool: "get_orders" },
      }),
    ).toMatchObject({
      route: {
        to: "/$org/agents/$agentId/apps/$connectionId/$toolName",
        params: {
          agentId: AGENT,
          connectionId: "conn_1",
          toolName: "get_orders",
        },
      },
    });
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "automations",
        search: { automation: "auto_1" },
      }),
    ).toMatchObject({
      route: {
        to: "/$org/agents/$agentId/automations/$automationId",
        params: { agentId: AGENT, automationId: "auto_1" },
      },
    });
  });

  it("lets an explicit legacy main value override the old panel segment", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "code",
        search: { main: "settings" },
      }),
    ).toMatchObject({
      route: { to: "/$org/agents/$agentId/settings" },
    });
  });

  it("keeps project-first overview owned by its named agent", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "overview",
        source: "project-first",
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: {},
    });
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "overview",
        source: "view-first",
      }),
    ).toMatchObject({ route: { to: "/$org/home" } });
  });

  it("canonicalizes an old panel path before applying main=0", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "code",
        search: {
          main: 0,
          virtualmcpid: AGENT,
          file: "src/a.tsx",
          sidepanel: true,
        },
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId/site-editor/code",
        params: { org: ORG, agentId: AGENT },
        search: { file: "src/a.tsx" },
      },
      search: {
        sidepanel: true,
        file: "src/a.tsx",
        mainpanel: false,
      },
    });
  });

  it("lands a truncated parameterized panel on the owning agent", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "app",
        search: {},
      }),
    ).toMatchObject({ route: { to: "/$org/agents/$agentId" } });
  });

  it("treats an old chat panel as the no-main state", () => {
    expect(
      translateLegacyPanelRoute({
        org: ORG,
        agentId: AGENT,
        panel: "chat",
        search: {},
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: { sidepanel: true, mainpanel: false },
    });
  });
});

describe("isCanonicalAgentIdSegment", () => {
  it("recognizes persisted and well-known agent id namespaces", () => {
    for (const id of [
      "vir_abc",
      "decopilot_org_1",
      "brand-context-setup_org_1",
      "site-diagnostics_org_1",
      "commerce-discovery_org_1",
      "studio-agent-manager_org_1",
      // The retired view-first grammar cannot distinguish this custom view
      // from a concrete canonical agent without a marker. Path identity wins.
      "vir_dashboard",
    ]) {
      expect(isCanonicalAgentIdSegment(id)).toBe(true);
    }
  });

  it("leaves arbitrary legacy view names distinguishable from agent ids", () => {
    for (const view of [
      "custom-dashboard",
      "reports",
      "app:conn:tool",
      "vir_",
    ]) {
      expect(isCanonicalAgentIdSegment(view)).toBe(false);
    }
  });
});

describe("resolveLegacyAgentId", () => {
  it("uses canonical path identity ahead of a redundant or stale query", () => {
    expect(
      resolveLegacyAgentId({
        agentIdParam: "agent-a",
        virtualMcpIdSearch: "agent-b",
        fallbackAgentId: "decopilot",
      }),
    ).toBe("agent-a");
    expect(
      resolveLegacyAgentId({
        agentIdParam: "agent-a",
        virtualMcpIdSearch: "agent-a",
      }),
    ).toBe("agent-a");
  });

  it("reads query identity when the path segment is a recognized old view", () => {
    expect(
      resolveLegacyAgentId({
        agentIdParam: "code",
        virtualMcpIdSearch: "agent-a",
        fallbackAgentId: "decopilot",
      }),
    ).toBe("agent-a");
    expect(
      resolveLegacyAgentId({
        agentIdParam: "hosting",
        virtualMcpIdSearch: "agent-a",
      }),
    ).toBe("agent-a");
  });

  it("uses an unscoped fallback when neither path nor query has identity", () => {
    expect(resolveLegacyAgentId({ fallbackAgentId: "decopilot" })).toBe(
      "decopilot",
    );
  });

  it("retires redundant query identity without disturbing route state", () => {
    expect(
      retireLegacyAgentSearch({
        virtualmcpid: "agent-a",
        thread: THREAD,
        sidepanel: false,
      }),
    ).toEqual({ thread: THREAD, sidepanel: false });
  });
});

describe("translateLegacyOrgDestinationAgentSearch", () => {
  it("promotes a cold scoped-Home link to the agent root", () => {
    expect(
      translateLegacyOrgDestinationAgentSearch({
        org: ORG,
        routePath: "/$org/home",
        search: { virtualmcpid: AGENT, sidepanel: true },
      }),
    ).toEqual({
      kind: "canonical",
      route: {
        to: "/$org/agents/$agentId",
        params: { org: ORG, agentId: AGENT },
        search: {},
      },
      search: { sidepanel: true },
    });
  });

  it("drops stale identity from organization-owned destinations", () => {
    for (const routePath of [
      "/$org/tasks/{-$taskKey}",
      "/$org/reports",
      "/$org/library",
      "/$org/discover",
    ]) {
      expect(
        translateLegacyOrgDestinationAgentSearch({
          org: ORG,
          routePath,
          search: { virtualmcpid: AGENT, sidepanel: false },
        }),
      ).toEqual({
        kind: "same-route",
        search: { sidepanel: false },
      });
    }
  });

  it("retires a blank Home identity without fabricating an agent", () => {
    expect(
      translateLegacyOrgDestinationAgentSearch({
        org: ORG,
        routePath: "/$org/home",
        search: { virtualmcpid: "  " },
      }),
    ).toEqual({ kind: "same-route", search: {} });
  });

  it("ignores canonical agent routes and searches with no legacy identity", () => {
    expect(
      translateLegacyOrgDestinationAgentSearch({
        org: ORG,
        routePath: "/$org/agents/$agentId/settings",
        search: { virtualmcpid: AGENT },
      }),
    ).toBeNull();
    expect(
      translateLegacyOrgDestinationAgentSearch({
        org: ORG,
        routePath: "/$org/home",
        search: {},
      }),
    ).toBeNull();
  });
});

interface TasksSearch {
  task?: string;
  view?: string;
  q?: string;
}

describe("promoteLegacyTaskParam", () => {
  it("leaves a URL without the legacy task query alone", () => {
    const filtersOnly: TasksSearch = { view: "list" };
    expect(promoteLegacyTaskParam(undefined, filtersOnly)).toBeNull();
    expect(promoteLegacyTaskParam("DECO-01", filtersOnly)).toBeNull();
  });

  it("moves a legacy task query into the path segment", () => {
    expect(
      promoteLegacyTaskParam(undefined, { task: "board_abc", q: "x" }),
    ).toEqual({ taskKey: "board_abc", search: { q: "x" } });
  });

  it("keeps an existing path segment and drops a stale query echo", () => {
    expect(promoteLegacyTaskParam("DECO-01", { task: "board_abc" })).toEqual({
      taskKey: "DECO-01",
      search: {},
    });
  });

  it("retires a blank task query", () => {
    expect(promoteLegacyTaskParam(undefined, { task: "  " })).toEqual({
      taskKey: undefined,
      search: {},
    });
  });
});
