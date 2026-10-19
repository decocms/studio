import { describe, expect, it } from "bun:test";
import {
  type HeldFrameNavigation,
  frameNavigationLoaded,
  nextFrameNavigation,
} from "./frame-navigation";

describe("nextFrameNavigation", () => {
  const idle: HeldFrameNavigation = { src: "/?__draft=v1", loading: false };

  it("gives the frame a new pointer and waits for its load", () => {
    const next = nextFrameNavigation(idle, "/?__draft=v2", true);
    expect(next).toEqual({ src: "/?__draft=v2", loading: true });
  });

  it("holds pointers that arrive while it loads, then takes only the latest", () => {
    let nav = nextFrameNavigation(idle, "/?__draft=v2", true);
    for (const v of ["v3", "v4", "v5"]) {
      const held = nextFrameNavigation(nav, `/?__draft=${v}`, true);
      expect(held).toBe(nav);
      nav = held;
    }
    expect(nav.src).toBe("/?__draft=v2");
    nav = frameNavigationLoaded(nav);
    expect(nav).toEqual({ src: "/?__draft=v2", loading: false });
    nav = nextFrameNavigation(nav, "/?__draft=v5", true);
    expect(nav).toEqual({ src: "/?__draft=v5", loading: true });
  });

  it("changes nothing for the same pointer", () => {
    expect(nextFrameNavigation(idle, idle.src, true)).toBe(idle);
    const loading = { src: "/a", loading: true };
    expect(nextFrameNavigation(loading, "/a", true)).toBe(loading);
    expect(frameNavigationLoaded(idle)).toBe(idle);
  });

  it("follows at once where it doesn't hold (not a Fast Preview frame)", () => {
    const loading = { src: "/a", loading: true };
    expect(nextFrameNavigation(loading, "/b", false)).toEqual({
      src: "/b",
      loading: false,
    });
    expect(nextFrameNavigation(idle, "/c", false)).toEqual({
      src: "/c",
      loading: false,
    });
    expect(nextFrameNavigation(idle, idle.src, false)).toBe(idle);
  });
});
