import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  CONFLICT_DIALOG_POLL_FAST_FOR_MS,
  CONFLICT_DIALOG_POLL_MS,
  CONFLICT_DIALOG_POLL_SLOW_MS,
  type PollClock,
  conflictPollDelay,
  startConflictDialogPoll,
  useConflictDialogPoll,
} from "./conflict-dialog-poll";

/** A manual clock: `advance` runs the timers that come due, in order. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: PollClock & {
    advance: (ms: number) => Promise<void>;
    pending: () => number;
    hide: boolean;
  } = {
    hide: false,
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    hidden: () => clock.hide,
    pending: () => timers.size,
    advance: async (ms) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        // Let a read's promise settle before the next timer.
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    },
  };
  return clock;
}

describe("startConflictDialogPoll", () => {
  it("reads once per interval, and never after it stops", async () => {
    const clock = fakeClock();
    let reads = 0;
    const stop = startConflictDialogPoll(
      () => ({ read: () => void reads++ }),
      clock,
    );
    expect(reads).toBe(0);
    await clock.advance(CONFLICT_DIALOG_POLL_MS - 1);
    expect(reads).toBe(0);
    await clock.advance(1);
    expect(reads).toBe(1);
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 3);
    expect(reads).toBe(4);
    stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 10);
    expect(reads).toBe(4);
  });

  it("skips a tick while its read runs, when asked, and while hidden", async () => {
    const clock = fakeClock();
    let reads = 0;
    let finish: () => void = () => {};
    let skip = false;
    const stop = startConflictDialogPoll(
      () => ({
        read: () => {
          reads++;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        skip: () => skip,
      }),
      clock,
    );
    await clock.advance(CONFLICT_DIALOG_POLL_MS);
    expect(reads).toBe(1);
    // The first read hasn't answered: no second one on top of it.
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 2);
    expect(reads).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    skip = true;
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 2);
    expect(reads).toBe(1);
    skip = false;
    clock.hide = true;
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 2);
    expect(reads).toBe(1);
    clock.hide = false;
    await clock.advance(CONFLICT_DIALOG_POLL_MS);
    expect(reads).toBe(2);
    stop();
  });

  it("keeps polling after a read fails", async () => {
    const clock = fakeClock();
    let reads = 0;
    const stop = startConflictDialogPoll(
      () => ({
        read: () => {
          reads++;
          return Promise.reject(new Error("502"));
        },
      }),
      clock,
    );
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 3);
    expect(reads).toBe(3);
    stop();
  });

  it("slows down once the dialog has been open a while", () => {
    expect(conflictPollDelay(0)).toBe(CONFLICT_DIALOG_POLL_MS);
    expect(conflictPollDelay(CONFLICT_DIALOG_POLL_FAST_FOR_MS - 1)).toBe(
      CONFLICT_DIALOG_POLL_MS,
    );
    expect(conflictPollDelay(CONFLICT_DIALOG_POLL_FAST_FOR_MS)).toBe(
      CONFLICT_DIALOG_POLL_SLOW_MS,
    );
  });
});

describe("useConflictDialogPoll", () => {
  it("starts when the dialog opens and stops when it closes", async () => {
    const clock = fakeClock();
    let reads = 0;
    const { rerender, unmount } = renderHook(
      ({ open }: { open: boolean }) =>
        useConflictDialogPoll(open, { read: () => void reads++ }, clock),
      { initialProps: { open: false } },
    );
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 3);
    expect(reads).toBe(0);
    expect(clock.pending()).toBe(0);

    act(() => rerender({ open: true }));
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 2);
    expect(reads).toBe(2);
    // Re-rendering while open keeps the one timer.
    act(() => rerender({ open: true }));
    expect(clock.pending()).toBe(1);

    act(() => rerender({ open: false }));
    expect(clock.pending()).toBe(0);
    await clock.advance(CONFLICT_DIALOG_POLL_MS * 3);
    expect(reads).toBe(2);

    act(() => rerender({ open: true }));
    expect(clock.pending()).toBe(1);
    unmount();
    expect(clock.pending()).toBe(0);
  });

  it("each tick uses the latest read", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const { rerender, unmount } = renderHook(
      ({ name }: { name: string }) =>
        useConflictDialogPoll(
          true,
          { read: () => void seen.push(name) },
          clock,
        ),
      { initialProps: { name: "first" } },
    );
    await clock.advance(CONFLICT_DIALOG_POLL_MS);
    act(() => rerender({ name: "second" }));
    await clock.advance(CONFLICT_DIALOG_POLL_MS);
    expect(seen).toEqual(["first", "second"]);
    unmount();
  });
});
