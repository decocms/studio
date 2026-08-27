import { describe, expect, test } from "bun:test";
import {
  resolveActiveAgentId,
  resolveDestinationProject,
  resolveDestinationThreadSearch,
  resolveRouteThreadId,
  resolveRouteVirtualMcpId,
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

describe("resolveRouteVirtualMcpId", () => {
  /**
   * THE BUG: "New chat" on `/$org/chat/<project>` created the thread on the
   * Super Agent, because the control only knew the legacy grammar — it read
   * `?virtualmcpid=` (absent there) and fell back to Decopilot. The
   * `{-$project}` segment IS the scope on a destination.
   */
  test("a destination's project segment names the agent", () => {
    expect(
      resolveRouteVirtualMcpId({
        projectParam: "project-1",
        decopilotId: DECOPILOT,
      }),
    ).toBe("project-1");
  });

  /**
   * The knock-on: once a stale `virtualmcpid` was written onto a project URL
   * it used to win and flip the whole workspace to the Super Agent. Path beats
   * search, so it cannot.
   */
  test("the path segment beats a stale ?virtualmcpid=", () => {
    expect(
      resolveRouteVirtualMcpId({
        projectParam: "project-1",
        virtualMcpIdSearch: DECOPILOT,
        decopilotId: DECOPILOT,
      }),
    ).toBe("project-1");
  });

  /** The legacy `/$org/$taskId` route has no project segment and genuinely
   *  carries its agent in search — unchanged. */
  test("the legacy route still reads ?virtualmcpid=", () => {
    expect(
      resolveRouteVirtualMcpId({
        virtualMcpIdSearch: "legacy-agent",
        decopilotId: DECOPILOT,
      }),
    ).toBe("legacy-agent");
  });

  test("a route naming no agent is the org's Super Agent", () => {
    expect(resolveRouteVirtualMcpId({ decopilotId: DECOPILOT })).toBe(
      DECOPILOT,
    );
  });
});

describe("resolveDestinationThreadSearch", () => {
  test("the page's own search survives a thread switch", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: { main: "board", sidepanel: true },
        changes: { main: "preview" },
        threadId: "thread-2",
        projectInPath: false,
      }),
    ).toEqual({ main: "preview", sidepanel: true, thread: "thread-2" });
  });

  /**
   * INVERTED: the switch used to layer straight over `prev`, so a
   * `virtualmcpid` written by an earlier navigation outlived the project it
   * contradicted and re-scoped the workspace on the next render.
   */
  test("a project in the path evicts the legacy agent param", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: { virtualmcpid: DECOPILOT, sidepanel: true },
        changes: { virtualmcpid: DECOPILOT },
        threadId: "thread-2",
        projectInPath: true,
      }),
    ).toEqual({ sidepanel: true, thread: "thread-2" });
  });

  /** Home, Reports and Library have no project segment, so the search key is
   *  the only record of the agent and has to keep travelling. */
  test("a destination with no project segment keeps carrying it", () => {
    expect(
      resolveDestinationThreadSearch({
        prev: {},
        changes: { virtualmcpid: "agent-9" },
        threadId: "thread-3",
        projectInPath: false,
      }),
    ).toEqual({ virtualmcpid: "agent-9", thread: "thread-3" });
  });
});

describe("resolveActiveAgentId", () => {
  /**
   * THE BUG, second site: the thread list's "New chat" read only
   * `?virtualmcpid=`, so on `/$org/chat/<project>` it found nothing and handed
   * the new chat to the Super Agent. The path segment answers first.
   */
  test("a destination's project segment names the agent", () => {
    expect(
      resolveActiveAgentId({
        projectParam: "project-1",
        threadVirtualMcpId: "agent-9",
      }),
    ).toBe("project-1");
  });

  test("the legacy route still reads ?virtualmcpid=", () => {
    expect(
      resolveActiveAgentId({
        virtualMcpIdSearch: "legacy-agent",
        threadVirtualMcpId: "agent-9",
      }),
    ).toBe("legacy-agent");
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

describe("resolveDestinationProject", () => {
  /**
   * The regression this closes: dropping `virtualmcpid` on a project route
   * without moving the segment left `/chat/A` showing a thread that belongs to
   * B — the workspace ran A's tools, sandbox and branch over B's conversation.
   */
  test("a thread from another project moves the segment", () => {
    expect(
      resolveDestinationProject({
        currentProject: "project-a",
        targetVirtualMcpId: "project-b",
      }),
    ).toBe("project-b");
  });

  test("a switch that names no agent stays on this project", () => {
    expect(resolveDestinationProject({ currentProject: "project-a" })).toBe(
      "project-a",
    );
  });

  /** Home/Reports/Library, and the deliberate all-projects `/$org/tasks`, have
   *  no segment to move — there `?virtualmcpid=` records the agent instead. */
  test("a route with no project segment gains none", () => {
    expect(
      resolveDestinationProject({ targetVirtualMcpId: "project-b" }),
    ).toBeUndefined();
  });

  /** The Super Agent is not a project, so its threads drop the segment rather
   *  than minting a `/chat/decopilot_…` segment for something that is not a
   *  project at all. */
  test("a Super Agent thread drops the segment", () => {
    expect(
      resolveDestinationProject({
        currentProject: "project-a",
        targetVirtualMcpId: DECOPILOT,
        decopilotId: DECOPILOT,
      }),
    ).toBeUndefined();
  });
});
