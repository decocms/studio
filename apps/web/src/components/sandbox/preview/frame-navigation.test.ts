import { describe, expect, it } from "bun:test";
import {
  type HeldFrameNavigation,
  frameNavigationLoaded,
  heldForChange,
  nextFrameNavigation,
  nextFrameSwap,
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

describe("nextFrameSwap", () => {
  const BASE = "https://site.example";
  const A = `${BASE}/?__draft=a`;
  const B = `${BASE}/?__draft=b`;
  const C = `${BASE}/?__draft=c`;
  const loaded = { base: BASE, frameSrc: A, loadedSrc: A, canSwap: true };

  it("swaps a moved draft pointer in, keeping the src the frame loaded", () => {
    const swap = nextFrameSwap(null, { ...loaded, wanted: B });
    expect(swap).toEqual({ base: BASE, src: A, shown: B });
    // The next save swaps again; the frame still keeps A.
    expect(nextFrameSwap(swap, { ...loaded, wanted: C })).toEqual({
      base: BASE,
      src: A,
      shown: C,
    });
    // Nothing moved: the same object.
    expect(nextFrameSwap(swap, { ...loaded, wanted: B })).toBe(swap);
    // Back to the URL the frame loaded: still a swap, to it.
    expect(nextFrameSwap(swap, { ...loaded, wanted: A })).toEqual({
      base: BASE,
      src: A,
      shown: A,
    });
  });

  it("loads the frame for another page, a page without HTML swap, or a frame still loading", () => {
    expect(
      nextFrameSwap(null, { ...loaded, wanted: `${BASE}/shirts?__draft=b` }),
    ).toBeNull();
    expect(
      nextFrameSwap(null, {
        ...loaded,
        wanted: "https://other.example/?__draft=b",
      }),
    ).toBeNull();
    expect(
      nextFrameSwap(null, { ...loaded, canSwap: false, wanted: B }),
    ).toBeNull();
    expect(
      nextFrameSwap(null, { ...loaded, loadedSrc: undefined, wanted: B }),
    ).toBeNull();
    // A swapped frame that can't swap the next one loads it.
    const swap = nextFrameSwap(null, { ...loaded, wanted: B });
    expect(
      nextFrameSwap(swap, { ...loaded, canSwap: false, wanted: C }),
    ).toBeNull();
  });

  it("a new frame (another base) forgets the swap", () => {
    const swap = nextFrameSwap(null, { ...loaded, wanted: B });
    const other = "https://sandbox.example";
    expect(
      nextFrameSwap(swap, {
        base: other,
        frameSrc: `${other}/`,
        loadedSrc: `${other}/`,
        canSwap: true,
        wanted: `${other}/`,
      }),
    ).toBeNull();
  });
});

describe("heldForChange", () => {
  const post = "https://site.example/blog/old-slug?__draft=v1";

  it("holds a move to another page while the change saves", () => {
    const renamed = "https://site.example/blog/new-slug?__draft=v1";
    expect(heldForChange(post, renamed, true)).toBe(post);
  });

  it("lets a new draft pointer for the same page in at once", () => {
    const moved = "https://site.example/blog/old-slug?__draft=v2";
    expect(heldForChange(post, moved, true)).toBe(moved);
  });

  it("takes the new page once the change has landed", () => {
    const renamed = "https://site.example/blog/new-slug?__draft=v2";
    expect(heldForChange(post, renamed, false)).toBe(renamed);
  });

  it("has nothing to hold before the frame shows a page", () => {
    expect(heldForChange(undefined, post, true)).toBe(post);
  });
});
