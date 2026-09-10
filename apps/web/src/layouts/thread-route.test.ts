import { describe, expect, test } from "bun:test";
import {
  resolveActiveAgentId,
  resolveDestinationSwitch,
  resolveDestinationThreadSearch,
  resolveRouteAgentId,
  resolveRouteThreadId,
  resolveThreadNavTarget,
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

describe("resolveThreadNavTarget", () => {
  /** `to: "."` re-interpolates the matched route's own params, so a destination stays put. */
  test("a destination route keeps the thread in its own search", () => {
    expect(
      resolveThreadNavTarget({
        threadInSearch: true,
        orgSlug: "acme",
        threadId: "thread-1",
      }),
    ).toEqual({ to: "." });
  });

  test("the legacy route keeps the thread in its path param", () => {
    expect(
      resolveThreadNavTarget({
        threadInSearch: false,
        orgSlug: "acme",
        threadId: "thread-1",
      }),
    ).toEqual({
      to: "/$org/$taskId",
      params: { org: "acme", taskId: "thread-1" },
    });
  });

  /** The settings tree carries no thread at all, so its sidebar must land on the legacy route. */
  test("a route outside the agent shell lands on the legacy route", () => {
    expect(
      resolveThreadNavTarget({
        threadInSearch: false,
        orgSlug: "acme",
        threadId: "new-thread",
      }),
    ).toEqual({
      to: "/$org/$taskId",
      params: { org: "acme", taskId: "new-thread" },
    });
  });

  /**
   * INVERTED from the old `navWith(currentTaskId || crypto.randomUUID())`:
   * a panel action on a route naming no thread used to interpolate a fabricated
   * id into `/$org/$taskId` and mint a thread row.
   */
  test("an empty thread id never resolves to the legacy route", () => {
    expect(
      resolveThreadNavTarget({
        threadInSearch: false,
        orgSlug: "acme",
        threadId: "",
      }),
    ).toEqual({ to: "." });
  });
});

describe("resolveRouteAgentId", () => {
  /** THE BUG: "New chat" on a project's workspace made the thread on the Super
   *  Agent, because nothing read the scope. The scope IS the agent — but only
   *  on the agents route; the next test says why. */
  test("the agents route reads its agent from ?virtualmcpid=", () => {
    expect(
      resolveRouteAgentId({
        virtualMcpIdSearch: "project-1",
        onAgentsRoute: true,
      }),
    ).toBe("project-1");
  });

  /** THE GATE: the param is RETAINED across navigation, so a destination that
   *  resolved it would let a leftover param turn `/$org/reports?virtualmcpid=`
   *  into a project workspace. Reports/Tasks/Library still ignore it. */
  test("an org-level destination ignores ?virtualmcpid=", () => {
    expect(
      resolveRouteAgentId({ virtualMcpIdSearch: "vir_x" }),
    ).toBeUndefined();
  });

  /** Home renders the SCOPED project's own overview (`HomeTab`), so it names
   *  that agent too. Without this, `useNavigateToAgent`'s no-panel branch sent
   *  a thread minted for the project to `/$org/home`, where it was created
   *  against the Super Agent and chat dispatched there. */
  test("home reads its agent from ?virtualmcpid=", () => {
    expect(
      resolveRouteAgentId({
        virtualMcpIdSearch: "project-1",
        onHomeRoute: true,
      }),
    ).toBe("project-1");
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
  test("a blank scope reads as no agent", () => {
    expect(
      resolveRouteAgentId({ virtualMcpIdSearch: "", onAgentsRoute: true }),
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
    ).toEqual({ main: "preview", sidepanel: true, thread: "thread-2" });
  });

  /** INVERTED once the scope and the legacy agent param became one key: the
   *  switch used to delete it unconditionally, which would now discard a filter
   *  the person chose — and futilely, since retention re-adds it anyway. */
  test("a scope the person chose survives a thread switch", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: { virtualmcpid: DECOPILOT, sidepanel: true },
        changes: {},
        threadId: "thread-2",
      }),
    ).toEqual({
      virtualmcpid: DECOPILOT,
      sidepanel: true,
      thread: "thread-2",
    });
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

describe("resolveActiveAgentId", () => {
  /**
   * THE BUG, second site: the thread list's "New chat" read only
   * `?virtualmcpid=`, so on `/$org/agents/<project>` it found nothing and handed
   * the new chat to the Super Agent. The route answers first.
   */
  test("the route's agent wins", () => {
    expect(
      resolveActiveAgentId({
        routeAgentId: "project-1",
        threadVirtualMcpId: "agent-9",
      }),
    ).toBe("project-1");
  });

  /** Home, Reports and Library name no agent, so the open thread's own is the
   *  only source left. */
  test("falls back to the open thread's agent", () => {
    expect(resolveActiveAgentId({ threadVirtualMcpId: "agent-9" })).toBe(
      "agent-9",
    );
  });

  /** `null`, never the Super Agent: the caller decides what "no agent" means. */
  test("a route and a thread that name none answer null", () => {
    expect(resolveActiveAgentId({})).toBeNull();
    expect(resolveActiveAgentId({ threadVirtualMcpId: null })).toBeNull();
  });
});

describe("resolveDestinationSwitch", () => {
  /**
   * The regression this closes: dropping `virtualmcpid` on a project route
   * without moving the segment left `/agents/A` showing a thread that belongs to
   * B — the workspace ran A's tools, sandbox and branch over B's conversation.
   */
  test("a thread from another project moves the segment", () => {
    expect(
      resolveDestinationSwitch({
        currentProject: "project-a",
        targetVirtualMcpId: "project-b",
      }),
    ).toEqual({ kind: "stay", project: "project-b" });
  });

  test("a switch that names no agent stays on this project", () => {
    expect(resolveDestinationSwitch({ currentProject: "project-a" })).toEqual({
      kind: "stay",
      project: "project-a",
    });
  });

  /** The Super Agent is not a project, so its threads drop the segment rather
   *  than minting a `/agents/decopilot_…` segment for something that is not a
   *  project at all. */
  test("a Super Agent thread drops the segment", () => {
    expect(
      resolveDestinationSwitch({
        currentProject: "project-a",
        targetVirtualMcpId: DECOPILOT,
        decopilotId: DECOPILOT,
      }),
    ).toEqual({ kind: "stay", project: undefined });
  });

  /**
   * INVERTED: an org-level destination used to gain no segment and keep the
   * agent in `?virtualmcpid=` instead — which is how opening a coding agent's
   * chat from Reports left the whole report scoped to that agent. There is no
   * segment to move on Home/Tasks/Reports/Library, so the switch leaves for the
   * workspace the thread's agent owns.
   */
  test("an org-level destination relocates to the agent's workspace", () => {
    expect(
      resolveDestinationSwitch({ targetVirtualMcpId: "project-b" }),
    ).toEqual({ kind: "relocate", project: "project-b" });
  });

  /** A bare `/$org/agents` has no segment either, and its threads belong to the
   *  agent that owns them just the same. */
  test("a bare agents route relocates as well", () => {
    expect(
      resolveDestinationSwitch({
        targetVirtualMcpId: "project-b",
        decopilotId: DECOPILOT,
      }),
    ).toEqual({ kind: "relocate", project: "project-b" });
  });

  /** A Super Agent thread already belongs on an org-level page, so it stays. */
  test("a Super Agent thread stays on an org-level destination", () => {
    expect(
      resolveDestinationSwitch({
        targetVirtualMcpId: DECOPILOT,
        decopilotId: DECOPILOT,
      }),
    ).toEqual({ kind: "stay", project: undefined });
  });
});
