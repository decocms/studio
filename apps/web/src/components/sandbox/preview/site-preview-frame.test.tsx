import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { beforeAll, describe, expect, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
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
}: {
  src?: string;
  changePending?: boolean;
  expectLoad?: number;
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
