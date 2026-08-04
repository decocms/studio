import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { describe, expect, test } from "bun:test";
import {
  attachTerminalTuiWheelNormalization,
  createTerminalTuiWheelState,
  resolveTerminalTuiWheelReportCount,
  shouldNormalizeTerminalTuiWheel,
} from "./terminal-tui-wheel";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

describe("terminal TUI wheel normalization", () => {
  test("carries fractional trackpad pixels until they fill a measured row", () => {
    const state = createTerminalTuiWheelState();
    const reports = [4, 4, 4, 4].map((deltaY) =>
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_PIXEL, deltaY },
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([0, 0, 0, 1]);
  });

  test("uses the rendered cell height rather than a fixed pixel step", () => {
    const compactState = createTerminalTuiWheelState();
    const spaciousState = createTerminalTuiWheelState();

    expect(
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_PIXEL, deltaY: 12 },
        compactState,
        { cellHeight: 12 },
      ),
    ).toBe(1);
    expect(
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_PIXEL, deltaY: 12 },
        spaciousState,
        { cellHeight: 24 },
      ),
    ).toBe(0);
  });

  test("drops fractional momentum when direction changes", () => {
    const state = createTerminalTuiWheelState();

    const reports = [4, 4, -12, -4].map((deltaY) =>
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_PIXEL, deltaY },
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([0, 0, 0, 1]);
  });

  test("converts line and page deltas into terminal rows", () => {
    const lineState = createTerminalTuiWheelState();
    const pageState = createTerminalTuiWheelState();

    expect(
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_LINE, deltaY: 2 },
        lineState,
      ),
    ).toBe(2);
    expect(
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_PAGE, deltaY: 1 },
        pageState,
        { rows: 30 },
      ),
    ).toBe(6);
  });

  test("compresses large discrete ticks into a bounded report batch", () => {
    const state = createTerminalTuiWheelState();

    expect(
      resolveTerminalTuiWheelReportCount(
        {
          deltaMode: DOM_DELTA_PIXEL,
          deltaY: 16 * 200,
          wheelDeltaY: -120 * 200,
        },
        state,
        { cellHeight: 16 },
      ),
    ).toBe(6);
  });

  test("ramps repeated discrete ticks without accelerating trackpad pixels", () => {
    const discreteState = createTerminalTuiWheelState();
    const trackpadState = createTerminalTuiWheelState();
    const timestamps = [0, 16, 32, 48, 64];

    const discreteReports = timestamps.map((timeStamp) =>
      resolveTerminalTuiWheelReportCount(
        {
          deltaMode: DOM_DELTA_PIXEL,
          deltaY: 12,
          timeStamp,
          wheelDeltaY: -120,
        },
        discreteState,
        { cellHeight: 16 },
      ),
    );
    const trackpadReports = timestamps.map((timeStamp) =>
      resolveTerminalTuiWheelReportCount(
        { deltaMode: DOM_DELTA_PIXEL, deltaY: 4, timeStamp },
        trackpadState,
        { cellHeight: 16 },
      ),
    );

    expect(discreteReports).toEqual([1, 1, 3, 3, 4]);
    expect(trackpadReports).toEqual([0, 0, 0, 1, 0]);
  });

  test("only takes over active fullscreen-TUI mouse reporting", () => {
    const active = {
      deltaY: 8,
      hasMouseReportingClass: true,
      mouseTrackingMode: "any" as const,
    };

    expect(shouldNormalizeTerminalTuiWheel(active)).toBeTrue();
    expect(
      shouldNormalizeTerminalTuiWheel({
        ...active,
        mouseTrackingMode: "none",
      }),
    ).toBeFalse();
    expect(
      shouldNormalizeTerminalTuiWheel({
        ...active,
        hasMouseReportingClass: false,
      }),
    ).toBeFalse();
    expect(
      shouldNormalizeTerminalTuiWheel({ ...active, replayed: true }),
    ).toBeFalse();
    expect(
      shouldNormalizeTerminalTuiWheel({ ...active, shiftKey: true }),
    ).toBeFalse();
    expect(
      shouldNormalizeTerminalTuiWheel({ ...active, deltaY: 0 }),
    ).toBeFalse();
  });

  test("replays one line event per resolved row without recursing", async () => {
    const element = document.createElement("div");
    element.classList.add("enable-mouse-events");
    document.body.appendChild(element);
    let handler: ((event: WheelEvent) => boolean) | null = null;
    const terminal = {
      attachCustomWheelEventHandler: (
        nextHandler: (event: WheelEvent) => boolean,
      ) => {
        handler = nextHandler;
      },
      element,
      modes: { mouseTrackingMode: "any" as const },
      rows: 30,
    };
    attachTerminalTuiWheelNormalization(terminal);
    const invokeHandler = (event: WheelEvent): boolean => {
      if (!handler) throw new Error("wheel handler was not attached");
      return handler(event);
    };
    let acceptedReplayEvents = 0;
    element.addEventListener("wheel", (event) => {
      if (invokeHandler(event as WheelEvent)) acceptedReplayEvents++;
    });

    expect(
      invokeHandler(
        new WheelEvent("wheel", {
          deltaMode: DOM_DELTA_LINE,
          deltaY: 3,
        }),
      ),
    ).toBeFalse();
    await Promise.resolve();

    expect(acceptedReplayEvents).toBe(3);
    element.remove();
  });

  test("drops queued reports if mouse tracking turns off before drain", async () => {
    const element = document.createElement("div");
    element.classList.add("enable-mouse-events");
    document.body.appendChild(element);
    let handler: ((event: WheelEvent) => boolean) | null = null;
    let mouseTrackingMode: "any" | "none" = "any";
    const terminal = {
      attachCustomWheelEventHandler: (
        nextHandler: (event: WheelEvent) => boolean,
      ) => {
        handler = nextHandler;
      },
      element,
      get modes() {
        return { mouseTrackingMode };
      },
      rows: 30,
    };
    attachTerminalTuiWheelNormalization(terminal);
    const invokeHandler = (event: WheelEvent): boolean => {
      if (!handler) throw new Error("wheel handler was not attached");
      return handler(event);
    };
    let replayEvents = 0;
    element.addEventListener("wheel", () => replayEvents++);

    invokeHandler(
      new WheelEvent("wheel", {
        deltaMode: DOM_DELTA_LINE,
        deltaY: 3,
      }),
    );
    mouseTrackingMode = "none";
    await Promise.resolve();

    expect(replayEvents).toBe(0);
    element.remove();
  });
});
