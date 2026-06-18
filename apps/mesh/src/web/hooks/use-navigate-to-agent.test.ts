import { describe, expect, it } from "bun:test";
import * as navigateToAgent from "./use-navigate-to-agent";

describe("getServerPinnedIds", () => {
  it("returns an empty list while agents are still loading", () => {
    const getServerPinnedIds = navigateToAgent.getServerPinnedIds as
      | ((agents: undefined) => string[])
      | undefined;
    expect(typeof getServerPinnedIds).toBe("function");
    expect(getServerPinnedIds(undefined)).toEqual([]);
  });
});
