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

describe("resolveTaskSwitchSearch — no memory (legacy behavior)", () => {
  test("defaults to chat side panel open, no main", () => {
    expect(resolve()).toEqual({ sidepanel: "chat" });
  });

  test("carries a system tab forward within the same agent", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "repo-1",
      }),
    ).toEqual({ virtualmcpid: "repo-1", main: "git", sidepanel: "chat" });
  });

  test("drops per-thread tabs when carrying forward", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "file:abc" },
        virtualMcpId: "repo-1",
      }),
    ).toEqual({ virtualmcpid: "repo-1", sidepanel: "chat" });
  });

  test("agent switch drops the previous view", () => {
    expect(
      resolve({
        prev: { virtualmcpid: "repo-1", main: "git" },
        virtualMcpId: "repo-2",
      }),
    ).toEqual({ virtualmcpid: "repo-2", sidepanel: "chat" });
  });

  test("param-less Super Agent → repo agent counts as a switch", () => {
    // prev has no virtualmcpid (Super Agent); target repo-1 differs → no carry.
    expect(
      resolve({ prev: { main: "overview" }, virtualMcpId: "repo-1" }),
    ).toEqual({
      virtualmcpid: "repo-1",
      sidepanel: "chat",
    });
  });

  test("opts.main is an explicit intent that wins", () => {
    expect(
      resolve({ prev: { virtualmcpid: "repo-1" }, opts: { main: "preview" } }),
    ).toEqual({ virtualmcpid: "repo-1", main: "preview", sidepanel: "chat" });
  });

  test("opts.autosend appends the sentinel", () => {
    expect(resolve({ opts: { autosend: true } })).toEqual({
      sidepanel: "chat",
      autosend: AUTOSEND,
    });
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
    const savedLayout: ThreadLayout = { main: "file:abc" };
    expect(resolve({ savedLayout })).toEqual({
      main: "file:abc",
      sidepanel: "chat",
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
    ).toEqual({ virtualmcpid: "repo-1", main: "preview", sidepanel: "chat" });
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
    ).toEqual({ virtualmcpid: "repo-1", sidepanel: "chat" });
  });

  test("opts.main still beats saved layout", () => {
    const savedLayout: ThreadLayout = { main: "preview", sidepanel: 0 };
    expect(resolve({ opts: { main: "settings" }, savedLayout })).toEqual({
      main: "settings",
      sidepanel: "chat",
    });
  });
});
