import { describe, expect, test } from "bun:test";
import { makeAckedSeqThrottle } from "./acked-seq-throttle";

describe("makeAckedSeqThrottle", () => {
  test("first call always returns true", () => {
    let now = 0;
    const t = makeAckedSeqThrottle(() => now);
    expect(t.shouldWrite(1)).toBe(true);
  });

  test("second call within the interval returns false", () => {
    let now = 0;
    const t = makeAckedSeqThrottle(() => now, 3000);
    t.shouldWrite(1); // first — consumes the free pass
    now = 1000; // 1s later, within 3s interval
    expect(t.shouldWrite(2)).toBe(false);
  });

  test("call after the interval elapses returns true", () => {
    let now = 0;
    const t = makeAckedSeqThrottle(() => now, 3000);
    t.shouldWrite(1);
    now = 3000; // exactly 3s later
    expect(t.shouldWrite(2)).toBe(true);
  });

  test("records the new time after allowing through, so next within-interval is still false", () => {
    let now = 0;
    const t = makeAckedSeqThrottle(() => now, 3000);
    t.shouldWrite(1);
    now = 3000;
    t.shouldWrite(2); // allowed, records now=3000
    now = 5000; // 2s after the second allow — within interval
    expect(t.shouldWrite(3)).toBe(false);
  });

  test("allows again after the second interval elapses", () => {
    let now = 0;
    const t = makeAckedSeqThrottle(() => now, 3000);
    t.shouldWrite(1);
    now = 3000;
    t.shouldWrite(2);
    now = 6001; // > 3s after second allow
    expect(t.shouldWrite(3)).toBe(true);
  });
});
