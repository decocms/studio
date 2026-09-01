import { describe, expect, it } from "bun:test";
import { keepAttachedPinnedViews } from "./attached-pinned-views";

const pins = [
  { connectionId: "conn_a", toolName: "dashboard" },
  { connectionId: "conn_gone", toolName: "dashboard" },
];

describe("keepAttachedPinnedViews", () => {
  it("drops pins for detached connections", () => {
    expect(keepAttachedPinnedViews(pins, ["conn_a"])).toEqual([pins[0]!]);
  });

  it("keeps everything while the connection list is still loading", () => {
    expect(keepAttachedPinnedViews(pins, [])).toEqual(pins);
  });

  it("keeps pins for attached connections that are erroring", () => {
    expect(keepAttachedPinnedViews(pins, ["conn_a", "conn_gone"])).toEqual(
      pins,
    );
  });
});
