import { describe, expect, test } from "bun:test";
import { resolveTaskSwitchSearch } from "./resolve-task-switch-search";
import type { ThreadLayout } from "@/lib/thread-layout-memory";
import { canonicalThreadRouteTarget } from "./main-panel-tabs/tab-route";

const DECOPILOT = "decopilot-agent";
const AUTOSEND = "1";

test("new chat keeps the open project app", () => {
  const target = resolveTaskSwitchSearch({
    prev: {
      virtualmcpid: "project-example",
      tabId: "app:connection-example:show_dashboard",
      mainpanel: true,
      sidepanel: true,
    },
    virtualMcpId: "project-example",
    decopilotId: DECOPILOT,
    savedLayout: null,
    opts: { newThread: true },
    autosendValue: AUTOSEND,
  });
  expect(
    canonicalThreadRouteTarget({
      org: "org_example",
      agentId: "project-example",
      superAgentId: DECOPILOT,
      tabId: target.tabId,
    }),
  ).toMatchObject({
    to: "/$org/projects/$agentId/apps/$connectionId/$toolName",
    params: {
      connectionId: "connection-example",
      toolName: "show_dashboard",
    },
  });
  expect(target.search).toMatchObject({ mainpanel: true, sidepanel: true });
});

function resolve(
  over: Partial<Parameters<typeof resolveTaskSwitchSearch>[0]> = {},
) {
  return resolveTaskSwitchSearch({
    prev: {},
    decopilotId: DECOPILOT,
    savedLayout: null,
    autosendValue: AUTOSEND,
    ...over,
  });
}

describe("new chat in an app", () => {
  const prev = {
    virtualmcpid: "project-example",
    tabId: "app:connection-example:show_dashboard",
    mainpanel: false,
    sidepanel: true,
  };

  test("reusing an empty chat preserves the current app instead of its saved view", () => {
    expect(
      resolve({
        prev,
        virtualMcpId: "project-example",
        opts: { newThread: true },
        savedLayout: { tab: "settings", sidepanel: false },
      }),
    ).toEqual({
      tabId: prev.tabId,
      search: {
        virtualmcpid: "project-example",
        mainpanel: false,
        sidepanel: true,
      },
    });
  });

  test("an explicit panel still wins", () => {
    expect(
      resolve({ prev, opts: { newThread: true, panel: "settings" } }).tabId,
    ).toBe("settings");
  });

  test("switching projects does not carry the source app", () => {
    expect(
      resolve({
        prev,
        virtualMcpId: "other-project",
        opts: { newThread: true },
      }).tabId,
    ).toBeUndefined();
  });

  test("selecting an existing chat still restores its layout", () => {
    expect(resolve({ prev, savedLayout: { tab: "settings" } }).tabId).toBe(
      "settings",
    );
  });

  test.each(["file:output-example", "deck:slides.html", "code:src%2Fapp.ts"])(
    "new chats do not inherit thread-specific view %s",
    (tabId) => {
      expect(
        resolve({ prev: { ...prev, tabId }, opts: { newThread: true } }).tabId,
      ).toBeUndefined();
    },
  );
});

describe("resolveTaskSwitchSearch — no memory (agent default applies)", () => {
  test("omits sidepanel so the agent-configured default applies", () => {
    // No saved layout → don't pin the chat panel; resolveDefaultPanelState
    // decides from the target agent's chatDefaultOpen / defaultMainView.
    expect(resolve()).toEqual({ tabId: undefined, search: {} });
  });

  test("carries a system tab forward within the same agent", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "git" },
        virtualMcpId: "repo-1",
      }),
    ).toEqual({ tabId: "git", search: { virtualmcpid: "repo-1" } });
  });

  test("drops per-thread tabs when carrying forward", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "file:abc" },
        virtualMcpId: "repo-1",
      }),
    ).toEqual({ tabId: undefined, search: { virtualmcpid: "repo-1" } });
  });

  test("agent switch drops the previous view", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "git" },
        virtualMcpId: "repo-2",
      }),
    ).toEqual({ tabId: undefined, search: { virtualmcpid: "repo-2" } });
  });

  test("param-less Super Agent → repo agent counts as a switch", () => {
    // prev has no virtualmcpid (Super Agent); target repo-1 differs → no carry.
    expect(
      resolve({ prev: { tabId: "overview" }, virtualMcpId: "repo-1" }),
    ).toEqual({ tabId: undefined, search: { virtualmcpid: "repo-1" } });
  });

  test("opts.panel is an explicit intent that wins", () => {
    expect(
      resolve({ prev: { virtualmcpid: "repo-1" }, opts: { panel: "preview" } }),
    ).toEqual({ tabId: "preview", search: { virtualmcpid: "repo-1" } });
  });

  test("opts.autosend appends the sentinel", () => {
    expect(resolve({ opts: { autosend: true } })).toEqual({
      tabId: undefined,
      search: { autosend: AUTOSEND },
    });
  });

  /** A `mainpanel` describes the thread being left, never the one being opened:
   *  the target's own default (or its memory) decides. */
  test("never carries the panel-visibility flag across a switch", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "git" },
        virtualMcpId: "repo-1",
      }).search,
    ).not.toHaveProperty("mainpanel", true);
  });

  test("omits sidepanel on agent switch (no saved layout)", () => {
    // Regression guard: the switch must not pin `sidepanel` in the URL. Its
    // omission is what lets resolveDefaultPanelState honor the target agent's
    // chatDefaultOpen / defaultMainView (see use-chat-layout-state.test.ts) instead
    // of forcing chat open — this function has no access to that config itself.
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "git" },
        virtualMcpId: "content-agent",
      }),
    ).toEqual({ tabId: undefined, search: { virtualmcpid: "content-agent" } });
  });
});

describe("resolveTaskSwitchSearch — restoring per-thread memory", () => {
  test("restores the target thread's saved view", () => {
    const savedLayout: ThreadLayout = { tab: "preview", sidepanel: true };
    expect(resolve({ prev: { virtualmcpid: "repo-1" }, savedLayout })).toEqual({
      tabId: "preview",
      search: { virtualmcpid: "repo-1", sidepanel: true },
    });
  });

  test("restores a per-thread tab the thread owned (keyed by task id)", () => {
    // No remembered sidepanel → omitted, so the agent default applies.
    const savedLayout: ThreadLayout = { tab: "file:abc" };
    expect(resolve({ savedLayout })).toEqual({
      tabId: "file:abc",
      search: {},
    });
  });

  test("restores a closed side panel", () => {
    const savedLayout: ThreadLayout = { tab: "git", sidepanel: false };
    expect(resolve({ savedLayout })).toEqual({
      tabId: "git",
      search: { sidepanel: false },
    });
  });

  test("restores a main panel the thread was left with collapsed", () => {
    const savedLayout: ThreadLayout = { tab: "preview", mainpanel: false };
    expect(resolve({ savedLayout })).toEqual({
      tabId: "preview",
      search: { mainpanel: false },
    });
  });

  test("saved layout overrides carry-forward of the source tab", () => {
    // Source thread has git open; target remembers preview → preview wins.
    const savedLayout: ThreadLayout = { tab: "preview" };
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "git" },
        virtualMcpId: "repo-1",
        savedLayout,
      }),
    ).toEqual({ tabId: "preview", search: { virtualmcpid: "repo-1" } });
  });

  test("empty saved layout restores the default (no carry-forward)", () => {
    // Target was last on its default view → returning keeps the default even if
    // the source thread had a system tab open.
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", tabId: "git" },
        virtualMcpId: "repo-1",
        savedLayout: {},
      }),
    ).toEqual({ tabId: undefined, search: { virtualmcpid: "repo-1" } });
  });

  test("opts.panel still beats saved layout", () => {
    // opts.panel wins the view; sidepanel is omitted, so the agent default applies.
    const savedLayout: ThreadLayout = { tab: "preview", sidepanel: false };
    expect(resolve({ opts: { panel: "settings" }, savedLayout })).toEqual({
      tabId: "settings",
      search: {},
    });
  });
});
