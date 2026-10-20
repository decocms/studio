import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { sseHub, ALL_ORGS, type SSEEvent } from "@/event-bus/sse-hub";
import {
  THREAD_ANALYTICS_LIVE,
  THREAD_ANALYTICS_ORG_LIST,
  THREAD_ANALYTICS_USAGE,
} from "./analytics";

// A member standing in their OWN org, which is not an admin org.
const memberCtx = {
  organization: { id: "org-1", slug: "acme" },
  auth: { user: { id: "user-1" } },
  access: { check: async () => {} },
  db: undefined,
  storage: {
    threadAnalytics: new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("storage must not be reached");
        },
      },
    ),
  },
} as unknown as StudioContext;

describe("thread analytics admin gate", () => {
  test("a plain member cannot read their own org's live feed", async () => {
    await expect(
      THREAD_ANALYTICS_LIVE.handler({ limit: 10 }, memberCtx),
    ).rejects.toThrow("only available in an admin org");
  });

  test("a plain member cannot read their own org's usage", async () => {
    await expect(THREAD_ANALYTICS_USAGE.handler({}, memberCtx)).rejects.toThrow(
      "only available in an admin org",
    );
  });

  test("the org list answers not-admin instead of listing tenants", async () => {
    expect(await THREAD_ANALYTICS_ORG_LIST.handler({}, memberCtx)).toEqual({
      isAdmin: false,
      orgs: [],
    });
  });
});

describe("sse hub all-orgs listener", () => {
  test("receives every org's events with the org id, alongside per-org listeners", () => {
    const all: [string, string][] = [];
    const own: string[] = [];
    sseHub.add({
      id: "all-1",
      organizationId: ALL_ORGS,
      typePatterns: null,
      push: (e, orgId) => all.push([e.id, orgId]),
    });
    sseHub.add({
      id: "own-1",
      organizationId: "org-a",
      typePatterns: null,
      push: (e) => own.push(e.id),
    });
    const ev = (id: string): SSEEvent => ({
      id,
      type: "decopilot.thread.status",
      source: "decopilot",
      time: new Date().toISOString(),
    });
    sseHub.emit("org-a", ev("1"));
    sseHub.emit("org-b", ev("2"));
    sseHub.remove(ALL_ORGS, "all-1");
    sseHub.remove("org-a", "own-1");
    sseHub.emit("org-b", ev("3"));

    expect(all).toEqual([
      ["1", "org-a"],
      ["2", "org-b"],
    ]);
    expect(own).toEqual(["1"]);
  });
});
