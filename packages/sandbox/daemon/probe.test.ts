import { describe, expect, test } from "bun:test";
import { cadence, reduce, type ProbeState } from "./probe";
import { PROBE_FAST_MS, PROBE_SLOW_MS } from "./constants";

const initial: ProbeState = {
  status: "booting",
  port: null,
  htmlSupport: false,
};

describe("reduce", () => {
  describe("port-change", () => {
    test("null → 3000 transitions to booting with new port", () => {
      const r = reduce(initial, { kind: "port-change", port: 3000 });
      expect(r.next).toEqual({
        status: "booting",
        port: 3000,
        htmlSupport: false,
      });
      expect(r.log).toBeUndefined();
    });

    test("same port is a no-op", () => {
      const state: ProbeState = {
        status: "online",
        port: 3000,
        htmlSupport: true,
      };
      const r = reduce(state, { kind: "port-change", port: 3000 });
      expect(r.next).toEqual(state);
    });

    test("3000 → 5173 from online resets to booting and clears htmlSupport", () => {
      const state: ProbeState = {
        status: "online",
        port: 3000,
        htmlSupport: true,
      };
      const r = reduce(state, { kind: "port-change", port: 5173 });
      expect(r.next).toEqual({
        status: "booting",
        port: 5173,
        htmlSupport: false,
      });
    });

    test("number → null transitions to booting", () => {
      const state: ProbeState = {
        status: "offline",
        port: 3000,
        htmlSupport: false,
      };
      const r = reduce(state, { kind: "port-change", port: null });
      expect(r.next).toEqual({
        status: "booting",
        port: null,
        htmlSupport: false,
      });
    });
  });

  describe("head-response", () => {
    test("booting → online with log on first response", () => {
      const state: ProbeState = {
        status: "booting",
        port: 3000,
        htmlSupport: false,
      };
      const r = reduce(state, {
        kind: "head-response",
        status: 200,
        isHtml: true,
      });
      expect(r.next).toEqual({
        status: "online",
        port: 3000,
        htmlSupport: true,
      });
      expect(r.log).toContain("port 3000");
      expect(r.log).toContain("status 200");
    });

    test("booting → online treats 404 as up (no special-casing)", () => {
      const state: ProbeState = {
        status: "booting",
        port: 3000,
        htmlSupport: false,
      };
      const r = reduce(state, {
        kind: "head-response",
        status: 404,
        isHtml: false,
      });
      expect(r.next.status).toBe("online");
      expect(r.next.htmlSupport).toBe(false);
    });

    test("online → online: no log, htmlSupport updates", () => {
      const state: ProbeState = {
        status: "online",
        port: 3000,
        htmlSupport: true,
      };
      const r = reduce(state, {
        kind: "head-response",
        status: 200,
        isHtml: false,
      });
      expect(r.next).toEqual({
        status: "online",
        port: 3000,
        htmlSupport: false,
      });
      expect(r.log).toBeUndefined();
    });

    test("offline → online: emits recovery log, htmlSupport refreshes", () => {
      const state: ProbeState = {
        status: "offline",
        port: 3000,
        htmlSupport: true,
      };
      const r = reduce(state, {
        kind: "head-response",
        status: 200,
        isHtml: true,
      });
      expect(r.next).toEqual({
        status: "online",
        port: 3000,
        htmlSupport: true,
      });
      expect(r.log).toContain("back online");
      expect(r.log).toContain("port 3000");
      expect(r.log).toContain("status 200");
    });
  });

  describe("head-failure", () => {
    test("online → offline with log", () => {
      const state: ProbeState = {
        status: "online",
        port: 3000,
        htmlSupport: true,
      };
      const r = reduce(state, { kind: "head-failure" });
      expect(r.next).toEqual({
        status: "offline",
        port: 3000,
        htmlSupport: true, // sticky on offline
      });
      expect(r.log).toContain("port 3000");
    });

    test("booting → booting: no change, no log", () => {
      const state: ProbeState = {
        status: "booting",
        port: 3000,
        htmlSupport: false,
      };
      const r = reduce(state, { kind: "head-failure" });
      expect(r.next).toEqual(state);
      expect(r.log).toBeUndefined();
    });

    test("offline → offline: no change, no log", () => {
      const state: ProbeState = {
        status: "offline",
        port: 3000,
        htmlSupport: true,
      };
      const r = reduce(state, { kind: "head-failure" });
      expect(r.next).toEqual(state);
      expect(r.log).toBeUndefined();
    });
  });
});

describe("cadence", () => {
  test("booting → fast", () => {
    expect(cadence({ status: "booting", port: 3000, htmlSupport: false })).toBe(
      PROBE_FAST_MS,
    );
  });

  test("online → slow", () => {
    expect(cadence({ status: "online", port: 3000, htmlSupport: true })).toBe(
      PROBE_SLOW_MS,
    );
  });

  test("offline → fast", () => {
    expect(cadence({ status: "offline", port: 3000, htmlSupport: true })).toBe(
      PROBE_FAST_MS,
    );
  });
});
