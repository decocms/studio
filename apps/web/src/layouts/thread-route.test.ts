import { describe, expect, test } from "bun:test";
import {
  resolveDestinationThreadSearch,
  resolveRouteAgentId,
  resolveRouteThreadId,
} from "./thread-route";

const DECOPILOT = "decopilot_k8PB5";

describe("resolveRouteThreadId", () => {
  test("reads the legacy route's path param", () => {
    expect(
      resolveRouteThreadId({
        taskIdParam: "thread-1",
        threadSearch: undefined,
      }),
    ).toBe("thread-1");
  });

  test("reads a destination route's ?thread=", () => {
    expect(
      resolveRouteThreadId({
        taskIdParam: undefined,
        threadSearch: "thread-2",
      }),
    ).toBe("thread-2");
  });

  test("the path param wins, so nothing ever reads both", () => {
    expect(
      resolveRouteThreadId({ taskIdParam: "path", threadSearch: "search" }),
    ).toBe("path");
  });

  /**
   * INVERTED: the absent thread used to be an empty string, which reads as an
   * id everywhere a string is expected. `null` is a different type, so a
   * consumer has to narrow it before it can stream, fetch or track against it.
   */
  test("a route that names no thread resolves to null", () => {
    expect(resolveRouteThreadId({})).toBeNull();
  });
});

describe("resolveRouteAgentId", () => {
  test("reads canonical agent identity from the path", () => {
    expect(
      resolveRouteAgentId({
        agentIdParam: "project-1",
      }),
    ).toBe("project-1");
  });

  test("canonical path identity wins over a conflicting legacy query", () => {
    expect(
      resolveRouteAgentId({
        agentIdParam: "agent-from-path",
        virtualMcpIdSearch: "stale-query-agent",
        legacyRoute: true,
      }),
    ).toBe("agent-from-path");
  });

  test("an org-owned destination ignores stale query identity", () => {
    expect(
      resolveRouteAgentId({ virtualMcpIdSearch: "vir_x" }),
    ).toBeUndefined();
  });

  /** The legacy `/$org/$taskId` route has no panel segment and genuinely
   *  carries its agent in search — the third and last reader. */
  test("the legacy route still reads ?virtualmcpid=", () => {
    expect(
      resolveRouteAgentId({
        virtualMcpIdSearch: "legacy-agent",
        legacyRoute: true,
      }),
    ).toBe("legacy-agent");
  });

  /** A blank value is not an agent. Reading it as one would send a project
   *  workspace to the Super Agent rather than leaving the scope unset. */
  test("a blank legacy identity reads as no agent", () => {
    expect(
      resolveRouteAgentId({ virtualMcpIdSearch: "   ", legacyRoute: true }),
    ).toBeUndefined();
  });

  test("a route naming no agent anywhere answers undefined", () => {
    expect(resolveRouteAgentId({})).toBeUndefined();
  });
});

describe("resolveDestinationThreadSearch", () => {
  test("the page's own search survives a thread switch", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: { main: "board", sidepanel: true },
        changes: { main: "preview" },
        threadId: "thread-2",
      }),
    ).toEqual({ sidepanel: true, thread: "thread-2" });
  });

  test("retired query identity never survives a thread switch", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: { virtualmcpid: DECOPILOT, sidepanel: true },
        changes: {},
        threadId: "thread-2",
      }),
    ).toEqual({ sidepanel: true, thread: "thread-2" });
  });

  /** The half that must NOT invert: a switch never INTRODUCES a scope. The
   *  thread row carries its own agent (`threads.virtual_mcp_id` is NOT NULL),
   *  so opening one never needs to write the URL. */
  test("a thread switch never introduces a scope", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: { sidepanel: true },
        changes: { virtualmcpid: "agent-9" },
        threadId: "thread-3",
      }),
    ).toEqual({ sidepanel: true, thread: "thread-3" });
  });
});
