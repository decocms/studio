import { describe, expect, test } from "bun:test";
import { createPortSniffer } from "./port-sniffer";

const VITE_READY = `  VITE v7.3.2  ready in 315 ms\n\n  ➜  Local:   http://localhost:3000/\n`;

describe("createPortSniffer", () => {
  test("returns true only on the chunk that first locks the port", () => {
    const s = createPortSniffer();
    expect(s.observe("dev", VITE_READY)).toBe(true);
    expect(s.current()).toBe(3000);
    // Already locked — later lines never retarget or re-signal.
    expect(s.observe("dev", "fetch http://localhost:9999/api")).toBe(false);
    expect(s.current()).toBe(3000);
  });

  test("ignores non-starter sources", () => {
    const s = createPortSniffer();
    expect(s.observe("task3", VITE_READY)).toBe(false);
    expect(s.current()).toBeNull();
  });

  test("no bind URL → no lock, no signal", () => {
    const s = createPortSniffer();
    expect(s.observe("dev", "compiling...")).toBe(false);
    expect(s.current()).toBeNull();
  });

  test("reset re-arms detection", () => {
    const s = createPortSniffer();
    s.observe("dev", VITE_READY);
    s.reset();
    expect(s.current()).toBeNull();
    expect(s.observe("start", "Listening on http://0.0.0.0:8000/")).toBe(true);
    expect(s.current()).toBe(8000);
  });
});
