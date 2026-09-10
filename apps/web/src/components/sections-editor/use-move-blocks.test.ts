import { describe, expect, test } from "bun:test";
import { applyMoveToDecofile } from "./use-move-blocks";

describe("applyMoveToDecofile", () => {
  test("writes and deletes land together, so no snapshot holds both keys", () => {
    const before = { old: { title: "T" }, other: { keep: true } };
    const after = applyMoveToDecofile(before, {
      writes: { new: { title: "T" } },
      deletes: ["old"],
    });
    expect(Object.keys(after).sort()).toEqual(["new", "other"]);
  });

  test("leaves untouched keys alone", () => {
    const other = { keep: true };
    const after = applyMoveToDecofile(
      { old: {}, other },
      { writes: { new: {} }, deletes: ["old"] },
    );
    expect(after.other).toBe(other);
  });

  test("a key that is both written and deleted survives — it is the target", () => {
    const after = applyMoveToDecofile(
      { same: { title: "old" } },
      { writes: { same: { title: "new" } }, deletes: ["same"] },
    );
    expect(after.same).toEqual({ title: "new" });
  });

  test("never mutates the snapshot it is given", () => {
    const before = { old: {} };
    applyMoveToDecofile(before, { writes: { new: {} }, deletes: ["old"] });
    expect(Object.keys(before)).toEqual(["old"]);
  });

  test("tolerates an unseeded cache", () => {
    expect(
      applyMoveToDecofile(undefined, { writes: { a: 1 }, deletes: ["b"] }),
    ).toEqual({ a: 1 });
  });
});
