import type { Terminal } from "@xterm/xterm";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const DEFAULT_TERMINAL_CELL_HEIGHT = 16;
const LEGACY_WHEEL_DELTA_UNIT = 120;
const LEGACY_WHEEL_DELTA_MIN = 100;
const DISCRETE_DISTANCE_GAIN = 1.6;
const DISCRETE_DISTANCE_CAP_ROWS = 6;
const BURST_DISTANCE_CAP_ROWS = 9;
const BURST_FULL_INTERVAL_MS = 16;
const BURST_MAX_INTERVAL_MS = 45;
const BURST_MAX_BONUS_ROWS = 3;
const BURST_RAMP_EVENTS = 4;
const MOMENTUM_TAIL_DECAY_RATIO = 0.85;
const XTERM_MOUSE_REPORTING_CLASS = "enable-mouse-events";
const REPLAYED_WHEEL_EVENT = Symbol("replayed-terminal-tui-wheel-event");

export type TerminalTuiWheelInput = {
  deltaMode?: number;
  deltaY: number;
  timeStamp?: number;
  wheelDelta?: number;
  wheelDeltaY?: number;
};

export type TerminalTuiWheelMetrics = {
  cellHeight?: number;
  rows?: number;
};

export type TerminalTuiWheelState = {
  fastStreak: number;
  lastDistanceRows: number | null;
  lastInputAt: number | null;
  pendingDirection: -1 | 0 | 1;
  pendingRows: number;
};

type TerminalTuiWheelTarget = Pick<
  Terminal,
  "attachCustomWheelEventHandler" | "element" | "rows"
> & {
  modes: Pick<Terminal["modes"], "mouseTrackingMode">;
};

type ReplayedWheelEvent = WheelEvent & {
  [REPLAYED_WHEEL_EVENT]?: true;
};

type TerminalTuiWheelReplayState = {
  distance: TerminalTuiWheelState;
  drainScheduled: boolean;
  pendingDirection: -1 | 0 | 1;
  pendingEvent: WheelEvent | null;
  pendingReports: number;
};

export function createTerminalTuiWheelState(): TerminalTuiWheelState {
  return {
    fastStreak: 0,
    lastDistanceRows: null,
    lastInputAt: null,
    pendingDirection: 0,
    pendingRows: 0,
  };
}

function wheelDirection(deltaY: number): -1 | 0 | 1 {
  if (deltaY < 0) return -1;
  if (deltaY > 0) return 1;
  return 0;
}

function legacyWheelDelta(event: TerminalTuiWheelInput): number | null {
  if (
    typeof event.wheelDeltaY === "number" &&
    Number.isFinite(event.wheelDeltaY)
  ) {
    return event.wheelDeltaY;
  }
  if (
    typeof event.wheelDelta === "number" &&
    Number.isFinite(event.wheelDelta)
  ) {
    return event.wheelDelta;
  }
  return null;
}

function hasDiscreteLegacyDelta(event: TerminalTuiWheelInput): boolean {
  const legacyDelta = legacyWheelDelta(event);
  return (
    legacyDelta !== null && Math.abs(legacyDelta) >= LEGACY_WHEEL_DELTA_MIN
  );
}

function isTrackpadPixelInput(event: TerminalTuiWheelInput): boolean {
  return (
    (event.deltaMode ?? DOM_DELTA_PIXEL) === DOM_DELTA_PIXEL &&
    !hasDiscreteLegacyDelta(event)
  );
}

function normalizedCellHeight(cellHeight: number | undefined): number {
  return typeof cellHeight === "number" &&
    Number.isFinite(cellHeight) &&
    cellHeight > 0
    ? cellHeight
    : DEFAULT_TERMINAL_CELL_HEIGHT;
}

function distanceInRows(
  event: TerminalTuiWheelInput,
  metrics: TerminalTuiWheelMetrics,
): number {
  if (!Number.isFinite(event.deltaY)) return 0;

  const deltaMode = event.deltaMode ?? DOM_DELTA_PIXEL;
  const deltaY = Math.abs(event.deltaY);
  const rowsFromDelta =
    deltaMode === DOM_DELTA_LINE
      ? deltaY
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * Math.max(1, metrics.rows ?? 1)
        : deltaY / normalizedCellHeight(metrics.cellHeight);
  const legacyDelta = legacyWheelDelta(event);
  const rowsFromLegacy =
    legacyDelta === null ? 0 : Math.abs(legacyDelta) / LEGACY_WHEEL_DELTA_UNIT;

  const rows = Math.max(rowsFromDelta, rowsFromLegacy);
  return isTrackpadPixelInput(event) ? rows : Math.max(1, rows);
}

function compressedDiscreteDistance(rows: number): number {
  if (rows <= 1) return rows;
  return Math.min(
    DISCRETE_DISTANCE_CAP_ROWS,
    1 + Math.log2(rows) * DISCRETE_DISTANCE_GAIN,
  );
}

function wheelInputTime(event: TerminalTuiWheelInput): number | null {
  return typeof event.timeStamp === "number" && Number.isFinite(event.timeStamp)
    ? event.timeStamp
    : null;
}

function burstBonusRows(
  event: TerminalTuiWheelInput,
  state: TerminalTuiWheelState,
  distanceRows: number,
): number {
  if (
    (event.deltaMode ?? DOM_DELTA_PIXEL) === DOM_DELTA_PIXEL &&
    !hasDiscreteLegacyDelta(event)
  ) {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    return 0;
  }

  const currentInputAt = wheelInputTime(event);
  if (currentInputAt === null) {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    return 0;
  }

  const elapsedMs =
    state.lastInputAt === null ? null : currentInputAt - state.lastInputAt;
  const isMomentumTail =
    state.lastDistanceRows !== null &&
    distanceRows < state.lastDistanceRows * MOMENTUM_TAIL_DECAY_RATIO;
  state.lastDistanceRows = distanceRows;
  state.lastInputAt = currentInputAt;

  if (
    isMomentumTail ||
    elapsedMs === null ||
    elapsedMs < 0 ||
    elapsedMs > BURST_MAX_INTERVAL_MS
  ) {
    state.fastStreak = 0;
    return 0;
  }

  const cadence =
    elapsedMs <= BURST_FULL_INTERVAL_MS
      ? 1
      : (BURST_MAX_INTERVAL_MS - elapsedMs) /
        (BURST_MAX_INTERVAL_MS - BURST_FULL_INTERVAL_MS);
  state.fastStreak = Math.min(BURST_RAMP_EVENTS, state.fastStreak + 1);
  return (
    BURST_MAX_BONUS_ROWS * cadence * (state.fastStreak / BURST_RAMP_EVENTS)
  );
}

export function resolveTerminalTuiWheelReportCount(
  event: TerminalTuiWheelInput,
  state: TerminalTuiWheelState,
  metrics: TerminalTuiWheelMetrics = {},
): number {
  const direction = wheelDirection(event.deltaY);
  if (direction === 0) return 0;

  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    state.pendingRows = 0;
  }
  state.pendingDirection = direction;

  const distanceRows = distanceInRows(event, metrics);
  const rows = isTrackpadPixelInput(event)
    ? distanceRows
    : Math.min(
        BURST_DISTANCE_CAP_ROWS,
        compressedDiscreteDistance(distanceRows) +
          burstBonusRows(event, state, distanceRows),
      );
  const totalRows = state.pendingRows + rows;
  const reports = Math.trunc(totalRows);
  state.pendingRows = totalRows - reports;
  return reports;
}

export function shouldNormalizeTerminalTuiWheel({
  deltaY,
  hasMouseReportingClass,
  mouseTrackingMode,
  replayed = false,
  shiftKey = false,
}: {
  deltaY: number;
  hasMouseReportingClass: boolean;
  mouseTrackingMode: Terminal["modes"]["mouseTrackingMode"];
  replayed?: boolean;
  shiftKey?: boolean;
}): boolean {
  return (
    mouseTrackingMode !== "none" &&
    hasMouseReportingClass &&
    Number.isFinite(deltaY) &&
    deltaY !== 0 &&
    !shiftKey &&
    !replayed
  );
}

function isReplayedWheelEvent(event: WheelEvent): boolean {
  return (event as ReplayedWheelEvent)[REPLAYED_WHEEL_EVENT] === true;
}

function cloneLineWheelEvent(event: WheelEvent): WheelEvent {
  const clone = new WheelEvent(event.type, {
    altKey: event.altKey,
    bubbles: event.bubbles,
    button: event.button,
    buttons: event.buttons,
    cancelable: event.cancelable,
    clientX: event.clientX,
    clientY: event.clientY,
    composed: event.composed,
    ctrlKey: event.ctrlKey,
    deltaMode: DOM_DELTA_LINE,
    deltaX: 0,
    deltaY: event.deltaY < 0 ? -1 : 1,
    deltaZ: 0,
    detail: event.detail,
    metaKey: event.metaKey,
    relatedTarget: event.relatedTarget,
    screenX: event.screenX,
    screenY: event.screenY,
    shiftKey: event.shiftKey,
    view: event.view,
  });
  Object.defineProperty(clone, REPLAYED_WHEEL_EVENT, { value: true });
  return clone;
}

function measuredCellHeight(
  terminal: TerminalTuiWheelTarget,
): number | undefined {
  const screen =
    terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
  const height = screen?.getBoundingClientRect().height;
  if (height === undefined || height <= 0 || terminal.rows <= 0) {
    return undefined;
  }
  return height / terminal.rows;
}

function clearReplayState(state: TerminalTuiWheelReplayState): void {
  state.drainScheduled = false;
  state.pendingDirection = 0;
  state.pendingEvent = null;
  state.pendingReports = 0;
}

function hasActiveMouseReporting(terminal: TerminalTuiWheelTarget): boolean {
  return (
    terminal.modes.mouseTrackingMode !== "none" &&
    terminal.element?.classList.contains(XTERM_MOUSE_REPORTING_CLASS) === true
  );
}

function drainReplayedWheelEvents(
  terminal: TerminalTuiWheelTarget,
  state: TerminalTuiWheelReplayState,
): void {
  const element = terminal.element;
  const event = state.pendingEvent;
  const reports = state.pendingReports;
  clearReplayState(state);

  if (
    !element ||
    !event ||
    reports <= 0 ||
    !hasActiveMouseReporting(terminal)
  ) {
    return;
  }

  for (let index = 0; index < reports; index++) {
    element.dispatchEvent(cloneLineWheelEvent(event));
  }
}

function queueReplayedWheelEvents(
  terminal: TerminalTuiWheelTarget,
  state: TerminalTuiWheelReplayState,
  event: WheelEvent,
  reportCount: number,
): void {
  const direction = wheelDirection(event.deltaY);
  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.pendingReports = 0;
  }
  state.pendingDirection = direction;

  if (reportCount <= 0) return;

  state.pendingEvent = event;
  state.pendingReports += reportCount;
  if (state.drainScheduled) return;

  state.drainScheduled = true;
  queueMicrotask(() => drainReplayedWheelEvents(terminal, state));
}

export function attachTerminalTuiWheelNormalization(
  terminal: TerminalTuiWheelTarget,
): void {
  const replayState: TerminalTuiWheelReplayState = {
    distance: createTerminalTuiWheelState(),
    drainScheduled: false,
    pendingDirection: 0,
    pendingEvent: null,
    pendingReports: 0,
  };
  let measuredRows = 0;
  let cachedCellHeight: number | undefined;
  const cellHeight = () => {
    if (terminal.rows !== measuredRows || cachedCellHeight === undefined) {
      measuredRows = terminal.rows;
      cachedCellHeight = measuredCellHeight(terminal);
    }
    return cachedCellHeight;
  };

  terminal.attachCustomWheelEventHandler((event) => {
    const shouldNormalize = shouldNormalizeTerminalTuiWheel({
      deltaY: event.deltaY,
      hasMouseReportingClass:
        terminal.element?.classList.contains(XTERM_MOUSE_REPORTING_CLASS) ===
        true,
      mouseTrackingMode: terminal.modes.mouseTrackingMode,
      replayed: isReplayedWheelEvent(event),
      shiftKey: event.shiftKey,
    });
    if (!shouldNormalize) return true;

    const reportCount = resolveTerminalTuiWheelReportCount(
      event,
      replayState.distance,
      {
        cellHeight: cellHeight(),
        rows: terminal.rows,
      },
    );
    queueReplayedWheelEvents(terminal, replayState, event, reportCount);
    return false;
  });
}
