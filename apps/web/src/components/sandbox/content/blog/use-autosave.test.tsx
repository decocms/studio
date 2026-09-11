import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useAutosave } from "./use-autosave";

type Doc = { v: string };

/**
 * Drives useAutosave with controllable `initial` and `isSaving` props so the
 * external re-seed path can be exercised without real timers or a network.
 */
function renderAutosave(initialProps: { initial: Doc; isSaving: boolean }) {
  return renderHook(
    ({ initial, isSaving }: { initial: Doc; isSaving: boolean }) =>
      useAutosave<Doc>(initial, () => {}, { delay: 10_000, isSaving }),
    { initialProps },
  );
}

describe("useAutosave re-seed guard", () => {
  it("re-seeds the draft from an external `initial` change once edits are settled", () => {
    const a = { v: "a" };
    const b = { v: "b" };
    const { result, rerender } = renderAutosave({
      initial: a,
      isSaving: false,
    });

    expect(result.current[0]).toEqual(a);

    rerender({ initial: b, isSaving: false });

    expect(result.current[0]).toEqual(b);
  });

  it("does NOT re-seed while a save is in flight, so a slow save's older echo can't revert a newer edit", () => {
    const a = { v: "a" };
    const b = { v: "b" };
    const c = { v: "c" };
    const { result, rerender } = renderAutosave({
      initial: a,
      isSaving: false,
    });

    // The newer edit `c` lives only in the local draft while save #1 runs.
    act(() => result.current[1](c));
    expect(result.current[0]).toEqual(c);

    // Save #1's older echo (`b`) lands while still in flight; draft must hold `c`.
    rerender({ initial: b, isSaving: true });
    expect(result.current[0]).toEqual(c);
  });

  it("does NOT re-seed while a debounced edit is pending", () => {
    const a = { v: "a" };
    const b = { v: "b" };
    const local = { v: "local" };
    const { result, rerender } = renderAutosave({
      initial: a,
      isSaving: false,
    });

    // A local edit schedules a (far-off) save, so `pending` is now true.
    act(() => result.current[1](local));
    expect(result.current[0]).toEqual(local);

    rerender({ initial: b, isSaving: false });
    expect(result.current[0]).toEqual(local);
  });

  it("`sync` clears the pending timer so a later settled re-seed applies", () => {
    const a = { v: "a" };
    const b = { v: "b" };
    const synced = { v: "synced" };
    const { result, rerender } = renderAutosave({
      initial: a,
      isSaving: false,
    });

    act(() => result.current[1]({ v: "typing" }));
    act(() => result.current[2](synced));
    expect(result.current[0]).toEqual(synced);

    rerender({ initial: b, isSaving: false });
    expect(result.current[0]).toEqual(b);
  });
});
