import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { RefObject } from "react";
import { useIframeLoadRecovery } from "./preview-iframe-recovery";

// Fakes setTimeout/clearTimeout with a manually-flushed queue so the
// watchdog/backoff timers in the hook can be advanced synchronously without
// waiting out real delays (LOAD_TIMEOUT_MS/RETRY_BASE_MS are 10s/1s).
function installFakeTimers() {
  const queue: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    const id = nextId++;
    queue.push({ id, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: unknown) => {
    const idx = queue.findIndex((t) => t.id === id);
    if (idx !== -1) queue.splice(idx, 1);
  }) as typeof clearTimeout;
  return {
    flushNext() {
      const next = queue.shift();
      if (!next) throw new Error("no pending timer to flush");
      act(() => next.fn());
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function createTrackedIframe() {
  const srcHistory: string[] = [];
  let src = "";
  const iframe = {
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      srcHistory.push(value);
    },
  } as HTMLIFrameElement;
  return { iframe, srcHistory };
}

describe("useIframeLoadRecovery", () => {
  let timers: ReturnType<typeof installFakeTimers>;

  beforeEach(() => {
    timers = installFakeTimers();
  });

  afterEach(() => {
    timers.restore();
  });

  it("bounces through about:blank before restoring the stuck src, since reassigning the identical string is a no-op in some browsers", () => {
    const { iframe, srcHistory } = createTrackedIframe();
    const src = "https://sandbox.example.dev/";
    iframe.src = src;
    const iframeRef = {
      current: iframe,
    } as RefObject<HTMLIFrameElement | null>;

    renderHook(() => useIframeLoadRecovery({ iframeRef, src, active: true }));

    // No `load` event ever arrives → the load-timeout watchdog fires and
    // schedules a backoff reload.
    timers.flushNext();
    // The backoff reload fires and must reassign `src`.
    timers.flushNext();

    expect(srcHistory.slice(-2)).toEqual(["about:blank", src]);
  });
});
