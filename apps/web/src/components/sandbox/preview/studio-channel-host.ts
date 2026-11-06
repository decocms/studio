/**
 * The preview's side of the Studio channel (a Blocks v8 site's page; see
 * `studio-modules/messages.ts`). When the framed page says `deco:ready`,
 * Studio answers `deco:load` for each of its modules (the wireframe, HTML
 * swap) and then talks to them once the page says `deco:loaded`.
 *
 * Only the frame's own window is heard (`event.source`), at the origin it
 * says `deco:ready` from; Studio answers to that origin alone. A new
 * `deco:ready` is a new document: what the old one had loaded is forgotten.
 *
 * {@link StudioChannelHost.refresh} asks HTML swap to show a save, or a new
 * URL of the page (a save's moved draft pointer: the frame keeps its src and
 * doesn't navigate; preview.tsx `nextFrameSwap`). It is
 * false when the page has no HTML swap, or when `url` isn't on the origin the
 * frame's document spoke from (a frame that navigated away never learns a
 * draft pointer): the preview loads the frame then;
 * a swap that fails, or doesn't start in {@link SWAP_START_TIMEOUT_MS},
 * reports `onSwapFailed` so the preview reloads after all.
 */
import {
  CHANNEL_MESSAGE,
  type PageChannelMessage,
} from "@/studio-modules/channel";
import {
  STUDIO_MODULE_NAMES,
  studioModuleUrl,
  type HtmlSwapIn,
  type HtmlSwapOut,
  type StudioModuleName,
  type WireframeIn,
  type WireframeOut,
} from "@/studio-modules/messages";

/** How long a refresh may wait for HTML swap's `start` before the preview reloads instead. */
export const SWAP_START_TIMEOUT_MS = 2_000;

export interface StudioChannelHostOptions {
  /** Studio's origin: where the modules are served from (`location.origin`). */
  studioOrigin: string;
  /** Studio's build version, in the module URLs. */
  build: string;
  /** The frame's window right now. */
  frame: () => Window | null;
  /** A wireframe module loaded in a new document: send it the page's state. */
  onWireframeReady?: () => void;
  /** The modules loaded in the frame's document changed (read them with `has`). */
  onModulesChange?: () => void;
  onWireframe?: (message: WireframeOut) => void;
  /** The swap asked for last is in the page. */
  onSwapEnd?: () => void;
  /** The swap asked for last failed or never started: reload instead. */
  onSwapFailed?: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export class StudioChannelHost {
  private origin: string | null = null;
  private readonly urls: Record<StudioModuleName, string>;
  private loaded = new Set<StudioModuleName>();
  private swapId = 0;
  private pendingSwap: { id: number; started: boolean } | null = null;
  private startTimer: Timer | null = null;

  constructor(private readonly options: StudioChannelHostOptions) {
    this.urls = Object.fromEntries(
      STUDIO_MODULE_NAMES.map((name) => [
        name,
        studioModuleUrl(options.studioOrigin, name, options.build),
      ]),
    ) as Record<StudioModuleName, string>;
  }

  /** Whether `name` is loaded in the frame's current document. */
  has(name: StudioModuleName): boolean {
    return this.loaded.has(name);
  }

  /** Handles one `message` event of Studio's window; true when it was the channel's. */
  handle(event: Pick<MessageEvent, "data" | "origin" | "source">): boolean {
    const frame = this.options.frame();
    if (!frame || event.source !== frame) return false;
    const data = event.data as { type?: unknown } | null;
    if (!data || typeof data.type !== "string") return false;
    if (data.type === CHANNEL_MESSAGE.ready) {
      this.ready(event.origin);
      return true;
    }
    if (event.origin !== this.origin) return false;
    const message = data as PageChannelMessage | WireframeOut | HtmlSwapOut;
    switch (message.type) {
      case CHANNEL_MESSAGE.loaded: {
        const name = this.nameOf(message.url);
        if (!name) return true;
        this.loaded.add(name);
        this.options.onModulesChange?.();
        if (name === "wireframe") this.options.onWireframeReady?.();
        return true;
      }
      case CHANNEL_MESSAGE.loadError: {
        const name = this.nameOf(message.url);
        if (name && this.loaded.delete(name)) {
          this.options.onModulesChange?.();
        }
        if (name === "html-swap") this.failSwap();
        return true;
      }
      case "wireframe:hover":
      case "wireframe:select":
        this.options.onWireframe?.(message);
        return true;
      case "html-swap:start":
        if (this.pendingSwap?.id === message.id) {
          this.pendingSwap.started = true;
          this.clearStartTimer();
        }
        return true;
      case "html-swap:end":
        if (this.pendingSwap?.id !== message.id) return true;
        this.pendingSwap = null;
        this.clearStartTimer();
        this.options.onSwapEnd?.();
        return true;
      case "html-swap:error":
        if (this.pendingSwap?.id === message.id) this.failSwap();
        return true;
      default:
        return false;
    }
  }

  /** Posts to the wireframe; false when it isn't loaded. */
  wireframe(message: WireframeIn): boolean {
    return this.post("wireframe", message);
  }

  /**
   * Asks HTML swap to show the page's current content, or `url`'s (a new URL
   * of the page: a save moved its draft pointer). False when the page has
   * none: the caller loads the frame.
   */
  refresh(url?: string): boolean {
    // The URL (its draft pointer) goes only to a document of its own origin:
    // a frame that navigated elsewhere never learns it, and loads it instead.
    if (url !== undefined && !this.isFrameOrigin(url)) return false;
    const id = ++this.swapId;
    const message: HtmlSwapIn = url
      ? { type: "html-swap:refresh", id, url }
      : { type: "html-swap:refresh", id };
    if (!this.post("html-swap", message)) return false;
    this.pendingSwap = { id, started: false };
    this.clearStartTimer();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.pendingSwap?.id === id && !this.pendingSwap.started) {
        this.failSwap();
      }
    }, SWAP_START_TIMEOUT_MS);
    return true;
  }

  /** The frame is going away (unmount, a new base): forget it and stop waiting. */
  dispose(): void {
    this.clearStartTimer();
    this.pendingSwap = null;
    this.loaded.clear();
    this.origin = null;
  }

  private ready(origin: string) {
    // A new document: the old one's modules are gone with it. One loaded
    // while a swap was pending was fetched since, so it shows the save.
    this.origin = origin;
    if (this.loaded.size) {
      this.loaded.clear();
      this.options.onModulesChange?.();
    }
    if (this.pendingSwap) {
      this.pendingSwap = null;
      this.clearStartTimer();
      this.options.onSwapEnd?.();
    }
    const frame = this.options.frame();
    for (const name of STUDIO_MODULE_NAMES) {
      frame?.postMessage(
        { type: CHANNEL_MESSAGE.load, url: this.urls[name] },
        origin,
      );
    }
  }

  private post(name: StudioModuleName, message: WireframeIn | HtmlSwapIn) {
    const frame = this.options.frame();
    if (!frame || !this.origin || !this.loaded.has(name)) return false;
    frame.postMessage(message, this.origin);
    return true;
  }

  private isFrameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private nameOf(url: unknown): StudioModuleName | null {
    return STUDIO_MODULE_NAMES.find((name) => this.urls[name] === url) ?? null;
  }

  private failSwap() {
    this.clearStartTimer();
    if (!this.pendingSwap) return;
    this.pendingSwap = null;
    this.options.onSwapFailed?.();
  }

  private clearStartTimer() {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }
}
