import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  confirmPreviewReloaded,
  getContentSyncState,
  registerContentPreview,
  resetContentSync,
  runContentChange,
} from "@/components/sections-editor/content-sync";
import { studioModuleUrl } from "@/studio-modules/messages";
import {
  SWAP_START_TIMEOUT_MS,
  StudioChannelHost,
} from "./studio-channel-host";

const STUDIO = "https://studio.example";
const SITE = "https://site.example";
const WIREFRAME = studioModuleUrl(STUDIO, "wireframe", "1.2.3");
const HTML_SWAP = studioModuleUrl(STUDIO, "html-swap", "1.2.3");

/** The frame's window: what Studio posted to it, with the target origin. */
function fakeFrame() {
  const posted: {
    message: { type: string; [k: string]: unknown };
    origin: string;
  }[] = [];
  const win = {
    postMessage: (message: { type: string }, origin: string) => {
      posted.push({ message, origin });
    },
  } as unknown as Window;
  return { win, posted };
}

function setup(
  overrides: Partial<ConstructorParameters<typeof StudioChannelHost>[0]> = {},
) {
  const frame = fakeFrame();
  const calls = {
    wireframeReady: 0,
    wireframe: [] as unknown[],
    swapEnd: 0,
    swapFailed: 0,
  };
  const host = new StudioChannelHost({
    studioOrigin: STUDIO,
    build: "1.2.3",
    frame: () => frame.win,
    onWireframeReady: () => calls.wireframeReady++,
    onWireframe: (m) => calls.wireframe.push(m),
    onSwapEnd: () => calls.swapEnd++,
    onSwapFailed: () => calls.swapFailed++,
    ...overrides,
  });
  /** A message from the page. */
  const fromPage = (
    data: unknown,
    {
      origin = SITE,
      source = frame.win as unknown,
    }: { origin?: string; source?: unknown } = {},
  ) => host.handle({ data, origin, source: source as Window });
  /** The page loaded both modules. */
  const loadBoth = () => {
    fromPage({ type: "deco:ready" });
    fromPage({ type: "deco:loaded", url: WIREFRAME });
    fromPage({ type: "deco:loaded", url: HTML_SWAP });
  };
  return { host, frame, calls, fromPage, loadBoth };
}

describe("the Studio channel's host", () => {
  it("answers deco:ready with deco:load for both modules, to the page's origin only", () => {
    const { frame, fromPage } = setup();
    expect(fromPage({ type: "deco:ready" })).toBe(true);
    expect(frame.posted).toEqual([
      { message: { type: "deco:load", url: WIREFRAME }, origin: SITE },
      { message: { type: "deco:load", url: HTML_SWAP }, origin: SITE },
    ]);
    // Versioned on Studio's own origin.
    expect(WIREFRAME).toBe(
      "https://studio.example/studio-modules/v1/wireframe.js?build=1.2.3",
    );
  });

  it("hears only the frame's own window", () => {
    const { frame, fromPage } = setup();
    expect(fromPage({ type: "deco:ready" }, { source: {} })).toBe(false);
    expect(fromPage({ type: "deco:ready" }, { source: null })).toBe(false);
    expect(frame.posted).toEqual([]);
  });

  it("after deco:ready, ignores the frame at any other origin", () => {
    const { host, calls, fromPage } = setup();
    fromPage({ type: "deco:ready" });
    expect(
      fromPage(
        { type: "deco:loaded", url: WIREFRAME },
        { origin: "https://evil.example" },
      ),
    ).toBe(false);
    expect(host.has("wireframe")).toBe(false);
    expect(calls.wireframeReady).toBe(0);
  });

  it("talks to a module only once the page loaded it, and tells the preview the wireframe is in", () => {
    const { host, frame, calls, fromPage } = setup();
    expect(host.wireframe({ type: "wireframe:activate" })).toBe(false);
    fromPage({ type: "deco:ready" });
    expect(host.wireframe({ type: "wireframe:activate" })).toBe(false);
    fromPage({ type: "deco:loaded", url: WIREFRAME });
    expect(calls.wireframeReady).toBe(1);
    expect(host.wireframe({ type: "wireframe:activate" })).toBe(true);
    expect(frame.posted.at(-1)).toEqual({
      message: { type: "wireframe:activate" },
      origin: SITE,
    });
    // A module URL the host never sent changes nothing.
    fromPage({ type: "deco:loaded", url: `${STUDIO}/other.js` });
    expect(host.has("html-swap")).toBe(false);
  });

  it("hands the wireframe's hover and selection to the preview", () => {
    const { calls, fromPage, loadBoth } = setup();
    loadBoth();
    fromPage({ type: "wireframe:hover", sectionIndex: 2 });
    fromPage({
      type: "wireframe:select",
      sectionIndex: 2,
      manifestKey: "site/sections/Hero.tsx",
      clickSeq: 1,
    });
    expect(calls.wireframe).toEqual([
      { type: "wireframe:hover", sectionIndex: 2 },
      {
        type: "wireframe:select",
        sectionIndex: 2,
        manifestKey: "site/sections/Hero.tsx",
        clickSeq: 1,
      },
    ]);
  });

  it("a new deco:ready is a new document: its modules load again", () => {
    const { host, frame, fromPage, loadBoth } = setup();
    loadBoth();
    expect(host.has("wireframe")).toBe(true);
    frame.posted.length = 0;
    fromPage({ type: "deco:ready" });
    expect(host.has("wireframe")).toBe(false);
    expect(frame.posted.map((p) => p.message.type)).toEqual([
      "deco:load",
      "deco:load",
    ]);
  });

  it("a module that failed to load is not talked to", () => {
    const { host, fromPage } = setup();
    fromPage({ type: "deco:ready" });
    fromPage({ type: "deco:load-error", url: HTML_SWAP, message: "CSP" });
    expect(host.refresh()).toBe(false);
  });
});

describe("refresh: HTML swap after a save", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("is false without HTML swap in the page: the preview reloads", () => {
    const { host, fromPage } = setup();
    expect(host.refresh()).toBe(false);
    fromPage({ type: "deco:ready" });
    fromPage({ type: "deco:loaded", url: WIREFRAME });
    expect(host.refresh()).toBe(false);
  });

  it("asks HTML swap to refresh and ends on its end", () => {
    const { host, frame, calls, fromPage, loadBoth } = setup();
    loadBoth();
    expect(host.refresh()).toBe(true);
    const sent = frame.posted.at(-1)!;
    expect(sent).toEqual({
      message: { type: "html-swap:refresh", id: 1 },
      origin: SITE,
    });
    fromPage({ type: "html-swap:start", id: 1 });
    jest.advanceTimersByTime(SWAP_START_TIMEOUT_MS * 3);
    expect(calls.swapEnd).toBe(0);
    expect(calls.swapFailed).toBe(0);
    fromPage({ type: "html-swap:end", id: 1 });
    expect(calls.swapEnd).toBe(1);
  });

  it("names the page's new URL when the draft pointer moved", () => {
    const { host, frame, fromPage, loadBoth } = setup();
    loadBoth();
    expect(host.refresh(`${SITE}/?__draft=moved`)).toBe(true);
    expect(frame.posted.at(-1)).toEqual({
      message: {
        type: "html-swap:refresh",
        id: 1,
        url: `${SITE}/?__draft=moved`,
      },
      origin: SITE,
    });
    fromPage({ type: "html-swap:start", id: 1 });
  });

  it("tells the preview when the frame's modules change", () => {
    let changes = 0;
    const { host, fromPage, loadBoth } = setup({
      onModulesChange: () => changes++,
    });
    loadBoth();
    expect(changes).toBe(2);
    expect(host.has("html-swap")).toBe(true);
    // A new document: nothing is loaded in it yet.
    fromPage({ type: "deco:ready" });
    expect(changes).toBe(3);
    expect(host.has("html-swap")).toBe(false);
    fromPage({ type: "deco:loaded", url: HTML_SWAP });
    fromPage({ type: "deco:load-error", url: HTML_SWAP, message: "CSP" });
    expect(changes).toBe(5);
    expect(host.has("html-swap")).toBe(false);
  });

  it("a superseded refresh's messages end nothing; the latest one's do", () => {
    const { host, calls, fromPage, loadBoth } = setup();
    loadBoth();
    host.refresh();
    host.refresh();
    fromPage({ type: "html-swap:end", id: 1 });
    fromPage({ type: "html-swap:error", id: 1, message: "aborted" });
    expect(calls).toMatchObject({ swapEnd: 0, swapFailed: 0 });
    fromPage({ type: "html-swap:start", id: 2 });
    fromPage({ type: "html-swap:end", id: 2 });
    expect(calls).toMatchObject({ swapEnd: 1, swapFailed: 0 });
  });

  it("a failed swap, or one that never starts, falls back to a reload", () => {
    const { host, calls, fromPage, loadBoth } = setup();
    loadBoth();
    host.refresh();
    fromPage({ type: "html-swap:start", id: 1 });
    fromPage({
      type: "html-swap:error",
      id: 1,
      message: "The page answered 500",
    });
    expect(calls.swapFailed).toBe(1);

    host.refresh();
    jest.advanceTimersByTime(SWAP_START_TIMEOUT_MS - 1);
    expect(calls.swapFailed).toBe(1);
    jest.advanceTimersByTime(1);
    expect(calls.swapFailed).toBe(2);
    // Its late end changes nothing.
    fromPage({ type: "html-swap:end", id: 2 });
    expect(calls.swapEnd).toBe(0);
  });

  it("a new document while a swap waits already shows the save", () => {
    const { host, calls, fromPage, loadBoth } = setup();
    loadBoth();
    host.refresh();
    fromPage({ type: "deco:ready" });
    expect(calls).toMatchObject({ swapEnd: 1, swapFailed: 0 });
  });

  it("dispose stops waiting", () => {
    const { host, calls, loadBoth } = setup();
    loadBoth();
    host.refresh();
    host.dispose();
    jest.advanceTimersByTime(SWAP_START_TIMEOUT_MS * 2);
    expect(calls).toMatchObject({ swapEnd: 0, swapFailed: 0 });
  });
});

describe("the progress bar over a save shown by HTML swap", () => {
  const SCOPE = "org/site";
  beforeEach(() => resetContentSync());
  afterEach(() => resetContentSync());

  it("starts on the save and ends on the swap's end, not before", async () => {
    const unregister = registerContentPreview(SCOPE);
    const { host, fromPage, loadBoth } = setup({
      // What the preview does on the swap's end (preview.tsx swapEnded).
      onSwapEnd: () => confirmPreviewReloaded(SCOPE),
    });
    loadBoth();
    let release!: () => void;
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    const change = runContentChange(
      {
        queryClient: new QueryClient(),
        orgSlug: "org",
        virtualMcpId: "site",
        branch: null,
        backend: null,
        cacheKey: null,
      },
      {
        kind: "edit",
        write: () => written,
      },
    );
    // The save is running: the bar is up.
    expect(getContentSyncState(SCOPE).phase).toBe("saving");
    release();
    await change;
    // Saved: the preview has to show it, still up.
    const state = getContentSyncState(SCOPE);
    expect(state.phase).toBe("reloading");
    expect(state.reload.navigates).toBe(false);
    // The preview asks for the swap (preview.tsx refreshPreviewContent).
    expect(host.refresh()).toBe(true);
    fromPage({ type: "html-swap:start", id: 1 });
    expect(getContentSyncState(SCOPE).phase).toBe("reloading");
    fromPage({ type: "html-swap:end", id: 1 });
    expect(getContentSyncState(SCOPE).phase).toBe("idle");
    unregister();
  });
});
