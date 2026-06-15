/**
 * Demo Mode — the Director.
 *
 * A plain (non-React) class that owns ALL timing for a scripted demo. Screenplays
 * are async functions that `await` the Director's primitives, so a demo reads
 * top-to-bottom like a storyboard:
 *
 *   await d.user("Optimize my storefront");
 *   await d.stream("On it — let me take a look.");
 *   await d.tool(takeScreenshot({ url, image }));
 *   await d.endTurn();
 *
 * Multiple agent sessions can run at once via tracks:
 *
 *   const a = d.track("acme"); const b = d.track("fin");
 *   await Promise.all([arc(a), arc(b)]);  // two agents stream in parallel
 *
 * Because the Director lives outside React and mutates `Store`s that components
 * subscribe to via `useSyncExternalStore`, no component needs `useEffect` to
 * animate (banned by `plugins/ban-use-effect.js`). All waits go through
 * `sleep(ms, { signal })` from `@decocms/std` (no hand-rolled timers) and honor
 * an `AbortSignal`, so the autoplay loop can cancel/restart cleanly on unmount.
 */
import { sleep } from "@decocms/std";
import type { Store } from "@/web/components/chat/store/store-primitive";
import type { ChatMessage } from "@/web/components/chat/types";
import {
  emptyAssistant,
  toolMetadataPart,
  toolPartPending,
  userMessage,
  type ToolStep,
} from "./message-builders";
import type { DemoChatState, DemoStores } from "./director-stores";

type Part = ChatMessage["parts"][number];
/** Mutable typed handle for the part the typewriter is revealing into. */
type RevealPart = { type: "text" | "reasoning"; text: string };

/** Thrown when a primitive runs after the demo was aborted. The runner swallows it. */
export class DemoAborted extends Error {}

export interface StreamOptions {
  /** characters per second for the typewriter reveal (default 55) */
  cps?: number;
  /** drop the text in fully at once (for large markdown blocks/tables that
   *  look broken mid-parse) — still followed by a short settle beat */
  instant?: boolean;
}

/**
 * One agent conversation. Holds its own draft/active-message/status and writes
 * to its own chat store. The real chat renderers read it via `useChatStream()`.
 */
export class Track {
  private draft: ChatMessage[] = [];
  private activeId: string | null = null;
  private status: DemoChatState["status"] = "ready";

  constructor(
    private readonly store: Store<DemoChatState>,
    private readonly signal: AbortSignal,
  ) {}

  wait(ms: number): Promise<void> {
    return sleep(ms, { signal: this.signal });
  }

  private throwIfAborted() {
    if (this.signal.aborted) throw new DemoAborted();
  }

  /** Snapshot the working draft with fresh references for the active message +
   *  its parts (so memoized renderers re-render). Other messages keep identity. */
  private commit() {
    const messages = this.draft.map((m) =>
      m.id === this.activeId
        ? { ...m, parts: m.parts.map((p) => ({ ...p })) }
        : m,
    );
    this.store.set({ messages, status: this.status });
  }

  private get active(): ChatMessage {
    const msg = this.draft.find((m) => m.id === this.activeId);
    if (!msg) throw new Error("Track: no active assistant message");
    return msg;
  }

  private startAssistantTurn() {
    const msg = emptyAssistant();
    this.draft.push(msg);
    this.activeId = msg.id;
    this.status = "streaming";
  }

  private ensureAssistant() {
    if (!this.activeId) this.startAssistantTurn();
  }

  /** Push a user message and a brief "submitted" beat. Closes any open turn. */
  async user(text: string): Promise<void> {
    this.activeId = null;
    this.draft.push(userMessage(text));
    this.status = "submitted";
    this.commit();
    await this.wait(450);
  }

  /** Append a text part to the current assistant turn and reveal it char by
   *  char (typewriter). Opens an assistant turn if none is active. */
  async stream(text: string, opts?: StreamOptions): Promise<void> {
    this.ensureAssistant();
    const part: RevealPart = { type: "text", text: "" };
    this.active.parts.push(part as unknown as Part);
    if (opts?.instant) {
      part.text = text;
      this.commit();
      await this.wait(500);
      return;
    }
    const cps = opts?.cps ?? 55;
    const stepMs = Math.max(8, Math.round(1000 / cps));
    for (let i = 1; i <= text.length; i++) {
      this.throwIfAborted();
      part.text = text.slice(0, i);
      this.commit();
      await this.wait(stepMs);
    }
  }

  /** Append a reasoning ("thinking") block, revealed like `stream`. */
  async think(text: string, opts?: StreamOptions): Promise<void> {
    this.ensureAssistant();
    const meta = this.active.metadata as
      | { reasoning_start_at?: string }
      | undefined;
    if (meta && !meta.reasoning_start_at) {
      meta.reasoning_start_at = new Date().toISOString();
    }
    const part: RevealPart = { type: "reasoning", text: "" };
    this.active.parts.push(part as unknown as Part);
    const cps = opts?.cps ?? 90;
    const stepMs = Math.max(8, Math.round(1000 / cps));
    for (let i = 1; i <= text.length; i++) {
      this.throwIfAborted();
      part.text = text.slice(0, i);
      this.commit();
      await this.wait(stepMs);
    }
    const m2 = this.active.metadata as
      | { reasoning_end_at?: string }
      | undefined;
    if (m2) m2.reasoning_end_at = new Date().toISOString();
    this.commit();
  }

  /** Run a tool call: show it loading, wait its latency, then resolve its
   *  output and emit the latency metadata part. */
  async tool(step: ToolStep): Promise<void> {
    this.ensureAssistant();
    const toolCallId = crypto.randomUUID();
    const part = toolPartPending(step.name, toolCallId, step.input);
    this.active.parts.push(part);
    this.commit();
    await this.wait(step.latencyMs);
    this.throwIfAborted();
    Object.assign(part, { state: "output-available", output: step.output });
    this.active.parts.push(toolMetadataPart(toolCallId, step.latencyMs));
    this.commit();
  }

  /** Run several tool steps concurrently within this turn (fan-out). */
  async parallel(steps: ToolStep[]): Promise<void> {
    await Promise.all(steps.map((s) => this.tool(s)));
  }

  /** Finalize the current assistant turn (status → ready). */
  endTurn(): void {
    this.status = "ready";
    this.activeId = null;
    this.commit();
  }
}

export class Director {
  private readonly tracks = new Map<string, Track>();

  constructor(
    private readonly stores: DemoStores,
    private readonly signal: AbortSignal,
  ) {}

  /** Get (or create) the conversation track for `id`. */
  track(id = "main"): Track {
    let track = this.tracks.get(id);
    if (!track) {
      track = new Track(this.stores.getChat(id), this.signal);
      this.tracks.set(id, track);
    }
    return track;
  }

  // ---- single-track convenience (proxy to the "main" track) ---------------

  user(text: string) {
    return this.track().user(text);
  }
  stream(text: string, opts?: StreamOptions) {
    return this.track().stream(text, opts);
  }
  think(text: string, opts?: StreamOptions) {
    return this.track().think(text, opts);
  }
  tool(step: ToolStep) {
    return this.track().tool(step);
  }
  parallel(steps: ToolStep[]) {
    return this.track().parallel(steps);
  }
  endTurn() {
    this.track().endTurn();
  }

  // ---- timing / staging ---------------------------------------------------

  /** Sleep `ms`, rejecting if the demo is aborted. */
  wait(ms: number): Promise<void> {
    return sleep(ms, { signal: this.signal });
  }

  /** Set the chapter caption shown over the stage (null clears it). */
  caption(text: string | null): void {
    this.stores.ui.update((s) => ({ ...s, caption: text }));
  }

  /** Type text into a demo input/terminal char by char (drives `ui.inputs[id]`). */
  async type(
    inputId: string,
    text: string,
    opts?: StreamOptions,
  ): Promise<void> {
    const cps = opts?.cps ?? 28;
    const stepMs = Math.max(12, Math.round(1000 / cps));
    for (let i = 1; i <= text.length; i++) {
      if (this.signal.aborted) throw new DemoAborted();
      const value = text.slice(0, i);
      this.stores.ui.update((s) => ({
        ...s,
        inputs: { ...s.inputs, [inputId]: value },
      }));
      await this.wait(stepMs);
    }
  }

  /** Set an input value instantly (no typing animation). */
  setInput(inputId: string, value: string): void {
    this.stores.ui.update((s) => ({
      ...s,
      inputs: { ...s.inputs, [inputId]: value },
    }));
  }

  /** Switch which org/workspace the viewer is looking at. Background tracks keep
   *  streaming, so returning to an org shows the work that ran while away. */
  setOrg(orgId: string): void {
    this.stores.ui.update((s) => ({ ...s, currentOrg: orgId }));
  }

  // ---- ghost cursor -------------------------------------------------------

  /** Show the ghost cursor, optionally at a starting viewport point. */
  showCursor(x?: number, y?: number): void {
    const cx =
      x ?? (typeof window !== "undefined" ? window.innerWidth / 2 : 640);
    const cy =
      y ?? (typeof window !== "undefined" ? window.innerHeight - 120 : 600);
    this.stores.cursor.set({
      x: cx,
      y: cy,
      clicking: false,
      visible: true,
      moveMs: 0,
    });
  }

  hideCursor(): void {
    this.stores.cursor.update((s) => ({ ...s, visible: false }));
  }

  /** Move the ghost cursor to a viewport point with an animated glide. */
  async moveCursor(x: number, y: number, moveMs = 650): Promise<void> {
    this.stores.cursor.set({ x, y, clicking: false, visible: true, moveMs });
    await this.wait(moveMs + 60);
  }

  /** Move to a `[data-demo-target="id"]` element and play a click pulse. The
   *  caller performs the resulting action (open modal, etc.) explicitly. */
  async click(targetId: string): Promise<void> {
    const el =
      typeof document !== "undefined"
        ? document.querySelector(`[data-demo-target="${targetId}"]`)
        : null;
    if (el) {
      const r = el.getBoundingClientRect();
      await this.moveCursor(r.left + r.width / 2, r.top + r.height / 2);
    }
    this.stores.cursor.update((s) => ({ ...s, clicking: true }));
    await this.wait(180);
    this.stores.cursor.update((s) => ({ ...s, clicking: false }));
    await this.wait(140);
  }

  /** Set the preview HTML for an org's preview pane (rendered in an iframe). */
  setPreview(orgId: string, html: string): void {
    this.setInput(`preview:${orgId}`, html);
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Clear all scripted state so the autoplay loop can replay from scratch. */
  reset(): void {
    this.tracks.clear();
    this.stores.resetAll();
  }
}
