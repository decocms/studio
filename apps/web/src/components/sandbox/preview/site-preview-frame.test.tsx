import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { DRAFT_SETTLE_MS } from "./frame-navigation.ts";
import { SitePreviewFrame } from "./site-preview-frame.tsx";

beforeAll(() => {
  // The frame is the site's page; nothing here needs it to load.
  const happyDOM = (
    window as unknown as {
      happyDOM?: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM;
  if (happyDOM) happyDOM.settings.disableIframePageLoading = true;
});

const post = "https://site.example/blog/post-a";
const iframeRef = createRef<HTMLIFrameElement>();

function Frame({
  src = post,
  changePending = false,
  expectLoad = 0,
  holdNavigation = false,
}: {
  src?: string;
  changePending?: boolean;
  expectLoad?: number;
  holdNavigation?: boolean;
}) {
  return (
    <SitePreviewFrame
      iframeRef={iframeRef}
      iframeBase="https://site.example"
      src={src}
      device="desktop"
      canvas={{ width: 1200, height: 800 }}
      title="Post"
      recoveryActive={false}
      changePending={changePending}
      expectLoad={expectLoad}
      holdNavigation={holdNavigation}
    />
  );
}

const bar = () => document.querySelector('[data-testid="preview-progress"]');
const frame = () => document.querySelector("iframe") as HTMLIFrameElement;
const load = () => act(() => void fireEvent.load(frame()));

describe("SitePreviewFrame's progress bar", () => {
  test("shows while the page first loads, and goes with its load", () => {
    render(<Frame />);
    expect(bar()).not.toBeNull();
    load();
    expect(bar()).toBeNull();
  });

  test("shows a change from its save until the load that brings it in", () => {
    const { rerender } = render(<Frame />);
    load();
    rerender(<Frame changePending />);
    expect(bar()).not.toBeNull();
    rerender(<Frame />);
    // Saved, but the page hasn't reloaded with it yet.
    expect(bar()).not.toBeNull();
    load();
    expect(bar()).toBeNull();
  });

  test("a reload that lands before the save ends still counts", () => {
    const { rerender } = render(<Frame />);
    load();
    rerender(<Frame changePending />);
    load();
    expect(bar()).not.toBeNull();
    rerender(<Frame />);
    expect(bar()).toBeNull();
  });

  test("a reload the caller asks for shows it until the frame loads", () => {
    const { rerender } = render(<Frame />);
    load();
    rerender(<Frame expectLoad={1} />);
    expect(bar()).not.toBeNull();
    load();
    expect(bar()).toBeNull();
  });
});

describe("SitePreviewFrame and a new page", () => {
  test("waits for the change to land, then the frame goes to it", () => {
    const renamed = "https://site.example/blog/post-b";
    const { rerender } = render(<Frame />);
    load();
    rerender(<Frame changePending src={renamed} />);
    expect(frame().getAttribute("src")).toBe(post);
    rerender(<Frame src={renamed} />);
    expect(frame().getAttribute("src")).toBe(renamed);
    expect(bar()).not.toBeNull();
    load();
    expect(bar()).toBeNull();
  });

  test("a new query on the same page goes in while the change saves", () => {
    const moved = `${post}?__draft=v2`;
    const { rerender } = render(<Frame />);
    load();
    rerender(<Frame changePending src={moved} />);
    expect(frame().getAttribute("src")).toBe(moved);
  });
});

describe("SitePreviewFrame in Fast Preview", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const version = (v: number) => `${post}?__draft=v${v}`;
  const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

  test("loads a new draft version once the saves have stood still", () => {
    const { rerender } = render(<Frame holdNavigation src={version(1)} />);
    load();
    rerender(<Frame holdNavigation changePending src={version(2)} />);
    wait(DRAFT_SETTLE_MS * 2);
    // Still saving: nothing to settle on yet.
    expect(frame().getAttribute("src")).toBe(version(1));
    rerender(<Frame holdNavigation src={version(2)} />);
    wait(DRAFT_SETTLE_MS - 1);
    expect(frame().getAttribute("src")).toBe(version(1));
    expect(bar()).not.toBeNull();
    wait(1);
    expect(frame().getAttribute("src")).toBe(version(2));
    load();
    expect(bar()).toBeNull();
  });

  test("a burst of saves loads only the last version", () => {
    const { rerender } = render(<Frame holdNavigation src={version(1)} />);
    load();
    for (const v of [2, 3, 4, 5]) {
      rerender(<Frame holdNavigation changePending src={version(v)} />);
      rerender(<Frame holdNavigation src={version(v)} />);
      wait(DRAFT_SETTLE_MS - 500);
      expect(frame().getAttribute("src")).toBe(version(1));
      // The bar stays up between loads: the change is still on its way.
      expect(bar()).not.toBeNull();
    }
    wait(500);
    expect(frame().getAttribute("src")).toBe(version(5));
  });

  test("another page goes in without waiting to settle", () => {
    const other = "https://site.example/blog/post-b?__draft=v1";
    const { rerender } = render(<Frame holdNavigation src={version(1)} />);
    load();
    rerender(<Frame holdNavigation src={other} />);
    expect(frame().getAttribute("src")).toBe(other);
  });
});
