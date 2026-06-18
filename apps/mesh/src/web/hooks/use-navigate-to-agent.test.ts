import { describe, expect, it } from "bun:test";
import { getServerPinnedIds } from "./use-navigate-to-agent";

describe("getServerPinnedIds", () => {
  it("returns an empty list while agents are still loading", () => {
    expect(getServerPinnedIds(undefined)).toEqual([]);
  });
});
