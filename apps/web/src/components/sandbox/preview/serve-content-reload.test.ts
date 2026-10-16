import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import { watchServeContentReload } from "./serve-content-reload";

function fakeFrame() {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    load: () => target.dispatchEvent(new Event("load")),
  } as unknown as HTMLIFrameElement & { load: () => void };
}

describe("watchServeContentReload", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("the frame doesn't reload itself: the editor reloads it once", () => {
    const frame = fakeFrame();
    const reload = mock(() => {});
    watchServeContentReload({
      iframe: frame,
      reload,
      waitMs: 1500,
      confirmMs: 500,
    });
    jest.advanceTimersByTime(1499);
    expect(reload).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    // The editor's own reload isn't watched: no second one.
    frame.load();
    jest.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the site reloads itself: one confirming reload after it, never a loop", () => {
    const frame = fakeFrame();
    const reload = mock(() => {});
    watchServeContentReload({
      iframe: frame,
      reload,
      waitMs: 1500,
      confirmMs: 500,
    });
    jest.advanceTimersByTime(600);
    frame.load(); // the site's reload, maybe still the previous save
    jest.advanceTimersByTime(499);
    expect(reload).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    frame.load(); // the confirming reload's own load
    jest.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a newer save cancels the pending reloads (it starts its own)", () => {
    const frame = fakeFrame();
    const reload = mock(() => {});
    const stop = watchServeContentReload({ iframe: frame, reload });
    frame.load();
    stop();
    jest.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();

    const stopWaiting = watchServeContentReload({ iframe: frame, reload });
    stopWaiting();
    frame.load();
    jest.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
  });
});
