import { describe, expect, test } from "bun:test";
import {
  canToggle,
  computeDefaultSizes,
  resolveDefaultPanelState,
} from "./use-layout-state";

// ---------------------------------------------------------------------------
// resolveDefaultPanelState
// ---------------------------------------------------------------------------

describe("resolveDefaultPanelState", () => {
  const orgId = "org_123";
  const decopilotId = `decopilot_${orgId}`;
  const agentId = "agent_abc";

  test("decopilot ID, no params → tasks closed, main closed, chat open", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: decopilotId,
      orgId,
      entityMetadata: null,
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: false,
      mainOpen: false,
      chatOpen: true,
    });
  });

  test("agent ID, entity default = null → tasks open, main closed, chat open", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: null,
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: false,
      chatOpen: true,
    });
  });

  test("agent ID, entity default = automation → tasks open, main open, chat closed", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: { defaultMainView: { type: "automation" } },
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: true,
      chatOpen: false,
    });
  });

  test("agent ID, entity default = automation, chatDefaultOpen = true → all open", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: {
        defaultMainView: { type: "automation" },
        chatDefaultOpen: true,
      },
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: true,
      chatOpen: true,
    });
  });

  test("agent ID, ?main param present → all open", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: { defaultMainView: { type: "automation" } },
      hasMainParam: true,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: true,
      chatOpen: true,
    });
  });

  test("non-agent route → all open", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: null,
      hasMainParam: false,
      isAgentHomeRoute: false,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: true,
      chatOpen: true,
    });
  });

  test("agent ID, entity metadata = null (loading) → tasks open, main closed, chat open", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: null,
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: false,
      chatOpen: true,
    });
  });

  test("agent ID, entity default = ext-apps → tasks open, main open, chat closed", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: { defaultMainView: { type: "ext-apps" } },
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: true,
      chatOpen: false,
    });
  });

  test("agent ID, entity default = settings → tasks open, main open, chat closed", () => {
    const result = resolveDefaultPanelState({
      virtualMcpId: agentId,
      orgId,
      entityMetadata: { defaultMainView: { type: "settings" } },
      hasMainParam: false,
      isAgentHomeRoute: true,
    });
    expect(result).toEqual({
      tasksOpen: true,
      mainOpen: true,
      chatOpen: false,
    });
  });
});

// ---------------------------------------------------------------------------
// canToggle
// ---------------------------------------------------------------------------

describe("canToggle", () => {
  test("panel open, expandedCount = 1 → no-op (false)", () => {
    expect(canToggle(true, 1)).toBe(false);
  });

  test("panel open, expandedCount = 2 → allow (true)", () => {
    expect(canToggle(true, 2)).toBe(true);
  });

  test("panel open, expandedCount = 3 → allow (true)", () => {
    expect(canToggle(true, 3)).toBe(true);
  });

  test("panel closed, expandedCount = 1 → allow (true)", () => {
    expect(canToggle(false, 1)).toBe(true);
  });

  test("panel closed, expandedCount = 0 → allow (true)", () => {
    expect(canToggle(false, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeDefaultSizes
// ---------------------------------------------------------------------------

describe("computeDefaultSizes", () => {
  test("all open → 20/45/35", () => {
    expect(
      computeDefaultSizes({ tasksOpen: true, mainOpen: true, chatOpen: true }),
    ).toEqual({ tasks: 20, main: 45, chat: 35 });
  });

  test("tasks closed → 0/65/35", () => {
    expect(
      computeDefaultSizes({ tasksOpen: false, mainOpen: true, chatOpen: true }),
    ).toEqual({ tasks: 0, main: 65, chat: 35 });
  });

  test("main closed → 20/0/80", () => {
    expect(
      computeDefaultSizes({ tasksOpen: true, mainOpen: false, chatOpen: true }),
    ).toEqual({ tasks: 20, main: 0, chat: 80 });
  });

  test("chat closed → 20/80/0", () => {
    expect(
      computeDefaultSizes({ tasksOpen: true, mainOpen: true, chatOpen: false }),
    ).toEqual({ tasks: 20, main: 80, chat: 0 });
  });

  test("only chat → 0/0/100", () => {
    expect(
      computeDefaultSizes({
        tasksOpen: false,
        mainOpen: false,
        chatOpen: true,
      }),
    ).toEqual({ tasks: 0, main: 0, chat: 100 });
  });

  test("only main → 0/100/0", () => {
    expect(
      computeDefaultSizes({
        tasksOpen: false,
        mainOpen: true,
        chatOpen: false,
      }),
    ).toEqual({ tasks: 0, main: 100, chat: 0 });
  });

  test("only tasks → 100/0/0", () => {
    expect(
      computeDefaultSizes({
        tasksOpen: true,
        mainOpen: false,
        chatOpen: false,
      }),
    ).toEqual({ tasks: 100, main: 0, chat: 0 });
  });
});
