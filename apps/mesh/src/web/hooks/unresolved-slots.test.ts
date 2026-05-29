import { describe, expect, it } from "bun:test";
import { unresolvedSlots } from "./unresolved-slots";

describe("unresolvedSlots", () => {
  it("returns [] when every slot resolves to a connection id", () => {
    const slots = [{ slot_app_id: "a" }, { slot_app_id: "b" }];
    expect(unresolvedSlots(slots, { a: "conn_1", b: "conn_2" })).toEqual([]);
  });

  it("returns slots whose app_id resolved to null", () => {
    const slots = [{ slot_app_id: "a" }, { slot_app_id: "b" }];
    expect(unresolvedSlots(slots, { a: "conn_1", b: null })).toEqual([
      { slot_app_id: "b" },
    ]);
  });

  it("treats an app_id missing from the map as unresolved", () => {
    const slots = [{ slot_app_id: "a" }, { slot_app_id: "b" }];
    expect(unresolvedSlots(slots, { a: "conn_1" })).toEqual([
      { slot_app_id: "b" },
    ]);
  });

  it("returns [] for an empty slot list", () => {
    expect(unresolvedSlots([], {})).toEqual([]);
  });
});
