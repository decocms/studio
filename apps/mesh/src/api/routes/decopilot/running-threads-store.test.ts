import { describe, expect, it } from "bun:test";
import { RUNNING_THREAD_IDLE_MS } from "@/core/constants";
import { __test } from "./running-threads-store";

const { prune, toRunningThreads } = __test;

describe("running-threads-store prune", () => {
  const now = 1_000_000_000;

  it("keeps entries within the idle window", () => {
    const org = { t1: { v: "a", t: "Alpha", o: "o1", p: now - 1000 } };
    expect(prune(org, now)).toEqual(org);
  });

  it("drops entries idle past the timeout (orphaned runs self-heal)", () => {
    const org = {
      fresh: { v: "a", t: "Alpha", o: "o1", p: now - 1000 },
      stale: {
        v: "b",
        t: "Beta",
        o: "o1",
        p: now - RUNNING_THREAD_IDLE_MS - 1,
      },
    };
    expect(prune(org, now)).toEqual({
      fresh: { v: "a", t: "Alpha", o: "o1", p: now - 1000 },
    });
  });

  it("keeps an entry exactly at the cutoff", () => {
    const org = {
      edge: { v: "a", t: null, o: "o1", p: now - RUNNING_THREAD_IDLE_MS },
    };
    expect(prune(org, now)).toEqual(org);
  });
});

describe("running-threads-store toRunningThreads", () => {
  it("maps stored entries to RunningThread shape", () => {
    expect(
      toRunningThreads({
        t1: { v: "a", t: "Alpha", o: "o1", p: 1 },
        t2: { v: "", t: null, o: "o2", p: 2 },
      }),
    ).toEqual([
      { id: "t1", virtual_mcp_id: "a", title: "Alpha", organization_id: "o1" },
      { id: "t2", virtual_mcp_id: "", title: null, organization_id: "o2" },
    ]);
  });
});
