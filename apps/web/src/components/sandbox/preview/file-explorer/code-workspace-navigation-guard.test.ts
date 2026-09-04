import { describe, expect, it } from "bun:test";
import { isSameCodeWorkspaceNavigation } from "./code-workspace-navigation-guard";

const identity = {
  orgSlug: "acme",
  virtualMcpId: "storefront",
  branch: "draft/alex",
  threadId: "thread-1",
};

describe("isSameCodeWorkspaceNavigation", () => {
  it("allows Site Editor child routes for the same thread", () => {
    expect(
      isSameCodeWorkspaceNavigation({
        identity,
        currentPathname: "/acme/agents/storefront/site-editor/code",
        nextPathname: "/acme/agents/storefront/site-editor/content",
        nextSearch: { thread: "thread-1", path: "/home" },
      }),
    ).toBe(true);
  });

  it("rejects another thread even within Site Editor", () => {
    expect(
      isSameCodeWorkspaceNavigation({
        identity,
        currentPathname: "/acme/agents/storefront/site-editor/code",
        nextPathname: "/acme/agents/storefront/site-editor",
        nextSearch: { thread: "thread-2" },
      }),
    ).toBe(false);
  });

  it("rejects navigation beyond the Site Editor boundary", () => {
    expect(
      isSameCodeWorkspaceNavigation({
        identity,
        currentPathname: "/acme/agents/storefront/site-editor/code",
        nextPathname: "/acme/agents/storefront/settings",
        nextSearch: { thread: "thread-1" },
      }),
    ).toBe(false);
  });

  it("does not confuse an organization named site-editor with the route", () => {
    expect(
      isSameCodeWorkspaceNavigation({
        identity: { ...identity, orgSlug: "site-editor" },
        currentPathname: "/site-editor/agents/storefront/site-editor/code",
        nextPathname: "/site-editor/agents/storefront/settings",
        nextSearch: { thread: "thread-1" },
      }),
    ).toBe(false);
  });

  it("handles workspaces without a thread", () => {
    expect(
      isSameCodeWorkspaceNavigation({
        identity: { ...identity, threadId: null },
        currentPathname: "/acme/agents/storefront/site-editor",
        nextPathname: "/acme/agents/storefront/site-editor/code",
        nextSearch: {},
      }),
    ).toBe(true);
  });
});
