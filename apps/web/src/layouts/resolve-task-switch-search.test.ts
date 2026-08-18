import { describe, expect, test } from "bun:test";
import { resolveTaskSwitchSearch } from "./resolve-task-switch-search";
import type { ThreadLayout } from "@/lib/thread-layout-memory";

const DECOPILOT = "decopilot-agent";
const AUTOSEND = "1";

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

describe("resolveTaskSwitchSearch — no memory (agent default applies)", () => {
  test("omits sidepanel so the agent-configured default applies", () => {
    // No saved layout → don't pin the chat panel; resolveDefaultPanelState
    // decides from the target agent's chatDefaultOpen / defaultMainView.
    expect(resolve()).toEqual({});
  });

  test("carries a system tab forward within the same agent", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "repo-1",
      }),
    ).toEqual({ virtualmcpid: "repo-1", main: "git" });
  });

  test("drops per-thread tabs when carrying forward", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "file:abc" },
        virtualMcpId: "repo-1",
      }),
    ).toEqual({ virtualmcpid: "repo-1" });
  });

  test("agent switch drops the previous view", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "repo-2",
      }),
    ).toEqual({ virtualmcpid: "repo-2" });
  });

  test("param-less Super Agent → repo agent counts as a switch", () => {
    // prev has no virtualmcpid (Super Agent); target repo-1 differs → no carry.
    expect(
      resolve({ prev: { main: "overview" }, virtualMcpId: "repo-1" }),
    ).toEqual({
      virtualmcpid: "repo-1",
    });
  });

  test("opts.main is an explicit intent that wins", () => {
    expect(
      resolve({ prev: { virtualmcpid: "repo-1" }, opts: { main: "preview" } }),
    ).toEqual({ virtualmcpid: "repo-1", main: "preview" });
  });

  test("opts.autosend appends the sentinel", () => {
    expect(resolve({ opts: { autosend: true } })).toEqual({
      autosend: AUTOSEND,
    });
  });

  test("omits sidepanel on agent switch (no saved layout)", () => {
    // Regression guard: the switch must not pin `sidepanel` in the URL. Its
    // omission is what lets resolveDefaultPanelState honor the target agent's
    // chatDefaultOpen / defaultMainView (see use-layout-state.test.ts) instead
    // of forcing chat open — this function has no access to that config itself.
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "content-agent",
      }),
    ).toEqual({ virtualmcpid: "content-agent" });
  });
});

describe("resolveTaskSwitchSearch — restoring per-thread memory", () => {
  test("restores the target thread's saved main tab", () => {
    const savedLayout: ThreadLayout = { main: "preview", sidepanel: "chat" };
    expect(resolve({ prev: { virtualmcpid: "repo-1" }, savedLayout })).toEqual({
      virtualmcpid: "repo-1",
      main: "preview",
      sidepanel: "chat",
    });
  });

  test("restores a per-thread tab the thread owned (keyed by task id)", () => {
    // No remembered sidepanel → omitted, so the agent default applies.
    const savedLayout: ThreadLayout = { main: "file:abc" };
    expect(resolve({ savedLayout })).toEqual({
      main: "file:abc",
    });
  });

  test("restores a closed side panel", () => {
    const savedLayout: ThreadLayout = { main: "git", sidepanel: 0 };
    expect(resolve({ savedLayout })).toEqual({ main: "git", sidepanel: 0 });
  });

  test("saved layout overrides carry-forward of the source tab", () => {
    // Source thread has git open; target remembers preview → preview wins.
    const savedLayout: ThreadLayout = { main: "preview" };
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "repo-1",
        savedLayout,
      }),
    ).toEqual({ virtualmcpid: "repo-1", main: "preview" });
  });

  test("empty saved layout restores the default (no carry-forward)", () => {
    // Target was last on its default view → returning keeps the default even if
    // the source thread had a system tab open.
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "repo-1",
        savedLayout: {},
      }),
    ).toEqual({ virtualmcpid: "repo-1" });
  });

  test("opts.main still beats saved layout", () => {
    // opts.main wins the main slot; the saved sidepanel is not consulted, so it
    // is omitted and the agent default applies.
    const savedLayout: ThreadLayout = { main: "preview", sidepanel: 0 };
    expect(resolve({ opts: { main: "settings" }, savedLayout })).toEqual({
      main: "settings",
    });
  });
});

describe("resolveTaskSwitchSearch — editing mode", () => {
  test("restores the remembered mode with the rest of the layout", () => {
    const next = resolveTaskSwitchSearch({
      prev: {},
      decopilotId: "dec_1",
      savedLayout: { main: "preview", sidepanel: "cms", mode: "vibecoding" },
      autosendValue: "1",
    });
    expect(next.mode).toBe("vibecoding");
  });

  /** No memory means "use the default", which the gate reads as CMS — not a
   *  stale mode carried over from whichever thread we came from. */
  test("omits mode when the target thread has none remembered", () => {
    const next = resolveTaskSwitchSearch({
      prev: {},
      decopilotId: "dec_1",
      savedLayout: { main: "preview" },
      autosendValue: "1",
    });
    expect(next.mode).toBeUndefined();
  });
});
