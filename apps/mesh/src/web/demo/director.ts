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
  customCardPart,
  dailyDigestPart,
  emptyAssistant,
  pullRequestPart,
  toolMetadataPart,
  toolPartPending,
  userMessage,
  workPlanPart,
  type ToolStep,
} from "./message-builders";
import type {
  DemoChatState,
  DemoStores,
  DigestState,
  PRState,
  PlanState,
} from "./director-stores";

type Part = ChatMessage["parts"][number];
/** Mutable typed handle for the part the typewriter is revealing into. */
type RevealPart = { type: "text" | "reasoning"; text: string };

/** Thrown when a primitive runs after the demo was aborted. The runner swallows it. */
export class DemoAborted extends Error {}

/** A track's speaker identity — either the deco logo or a glyph tile. */
export interface TrackSender {
  name: string;
  /** render the deco logo as the avatar (Decopilot) */
  logo?: boolean;
  glyph?: string;
  /** tailwind classes for the glyph tile */
  tile?: string;
}

/** Sleep `ms` of UNPAUSED time, in short chunks so Esc-pause takes effect
 *  within ~150ms. While `isPaused()` is true the clock simply doesn't run. */
async function pausableSleep(
  ms: number,
  signal: AbortSignal,
  isPaused: () => boolean,
): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    if (signal.aborted) throw new DemoAborted();
    if (isPaused()) {
      await sleep(150, { signal });
      continue;
    }
    const chunk = Math.min(remaining, 150);
    await sleep(chunk, { signal });
    remaining -= chunk;
  }
}

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
  /** message ids holding live inline cards (plan/PR) — always re-cloned on
   *  commit so their updates render even after the turn ends. */
  private readonly cardMsgIds = new Set<string>();
  // Live handles to the card parts. We replace `.output` with a NEW object on
  // every update (never mutate in place) so the card's prop identity changes
  // and React (compiler-memoized) actually re-renders.
  private planPart: { output: PlanState } | null = null;
  private prPart: { output: PRState } | null = null;
  private digestPart: { output: DigestState } | null = null;
  /** Who speaks on this track — rendered as a header row on every assistant
   *  turn (avatar tile or logo + name), like a real chat sender. */
  private sender: TrackSender | null = null;

  constructor(
    private readonly store: Store<DemoChatState>,
    private readonly signal: AbortSignal,
    private readonly isPaused: () => boolean = () => false,
  ) {}

  /** Set this track's speaker identity. Chainable; call once per scenario. */
  setSender(sender: TrackSender): this {
    this.sender = sender;
    return this;
  }

  wait(ms: number): Promise<void> {
    return pausableSleep(ms, this.signal, this.isPaused);
  }

  private throwIfAborted() {
    if (this.signal.aborted) throw new DemoAborted();
  }

  /** Snapshot the working draft with fresh references for the active message +
   *  its parts (so memoized renderers re-render). Other messages keep identity. */
  private commit() {
    const messages = this.draft.map((m) =>
      m.id === this.activeId || this.cardMsgIds.has(m.id)
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
    if (this.sender) {
      msg.parts.push(customCardPart("sender", this.sender));
    }
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

  /** Run several tool steps concurrently within this turn (fan-out). `staggerMs`
   *  delays each successive start so they don't all pop at once. */
  async parallel(steps: ToolStep[], staggerMs = 0): Promise<void> {
    await Promise.all(
      steps.map(async (s, i) => {
        if (staggerMs && i > 0) await this.wait(staggerMs * i);
        await this.tool(s);
      }),
    );
  }

  // ---- inline work-plan (sprint) + PR cards ------------------------------

  /** Append an inline work-plan card to the current turn (tasks queued). */
  showPlan(title: string, tasks: { title: string; detail?: string }[]): void {
    this.ensureAssistant();
    const output: PlanState = {
      title,
      accepted: false,
      tasks: tasks.map((t) => ({ ...t, status: "queued" })),
    };
    const part = workPlanPart(output);
    this.planPart = part as unknown as { output: PlanState };
    this.active.parts.push(part);
    this.cardMsgIds.add(this.active.id);
    this.commit();
  }

  acceptPlan(): void {
    if (!this.planPart) return;
    this.planPart.output = { ...this.planPart.output, accepted: true };
    this.commit();
  }

  setTask(index: number, status: "queued" | "active" | "done"): void {
    if (!this.planPart) return;
    const o = this.planPart.output;
    this.planPart.output = {
      ...o,
      tasks: o.tasks.map((t, i) => (i === index ? { ...t, status } : t)),
    };
    this.commit();
  }

  /** Append an inline PR card (checks running). */
  openPR(pr: {
    number: number;
    title: string;
    branch: string;
    files: number;
    additions: number;
    deletions: number;
  }): void {
    this.ensureAssistant();
    const output: PRState = { ...pr, checks: "running", merged: false };
    const part = pullRequestPart(output);
    this.prPart = part as unknown as { output: PRState };
    this.active.parts.push(part);
    this.cardMsgIds.add(this.active.id);
    this.commit();
  }

  passPRChecks(): void {
    if (!this.prPart) return;
    this.prPart.output = { ...this.prPart.output, checks: "passed" };
    this.commit();
  }

  mergePR(): void {
    if (!this.prPart) return;
    this.prPart.output = { ...this.prPart.output, merged: true };
    this.commit();
  }

  /** Append a static inline card rendered by a registered demo part renderer
   *  (`tool-<type>`). For cards with no post-render state updates. */
  showCard(type: string, output: unknown): void {
    this.ensureAssistant();
    this.active.parts.push(customCardPart(type, output));
    this.commit();
  }

  /** Append an inline "get this every day" digest CTA card. */
  showDigest(): void {
    this.ensureAssistant();
    const part = dailyDigestPart({ connected: null } as DigestState);
    this.digestPart = part as unknown as { output: DigestState };
    this.active.parts.push(part);
    this.cardMsgIds.add(this.active.id);
    this.commit();
  }

  connectDigest(channel: "slack" | "teams"): void {
    if (!this.digestPart) return;
    this.digestPart.output = { connected: channel };
    this.commit();
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

  /** True while the viewer has Esc-paused the show. */
  private readonly isPaused = () => this.stores.ui.get().inputs.paused === "1";

  /** Get (or create) the conversation track for `id`. */
  track(id = "main"): Track {
    let track = this.tracks.get(id);
    if (!track) {
      track = new Track(this.stores.getChat(id), this.signal, this.isPaused);
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
  parallel(steps: ToolStep[], staggerMs = 0) {
    return this.track().parallel(steps, staggerMs);
  }
  endTurn() {
    this.track().endTurn();
  }

  // ---- timing / staging ---------------------------------------------------

  /** Sleep `ms` of unpaused time, rejecting if the demo is aborted. */
  wait(ms: number): Promise<void> {
    return pausableSleep(ms, this.signal, this.isPaused);
  }

  /** Semantic pause between beats (reads better than bare `wait` in scripts). */
  beat(ms = 900): Promise<void> {
    return this.wait(ms);
  }

  /** Set the chapter caption shown over the stage (null clears it). */
  caption(text: string | null): void {
    this.stores.ui.update((s) => ({ ...s, caption: text }));
  }

  // ---- ending / replay ----------------------------------------------------

  /** Mark the demo finished — the stage shows the end card (replay / sign up). */
  markEnded(): void {
    this.stores.ui.update((s) => ({ ...s, ended: true, caption: null }));
    this.stores.cursor.update((c) => ({ ...c, visible: false }));
  }

  /** Resolve when the viewer presses Play on the start card (`inputs.started`)
   *  or on abort. The Play click doubles as the browser's audio unlock, so
   *  the FIRST narration line actually narrates. */
  awaitStart(): Promise<void> {
    return new Promise((resolve) => {
      if (this.signal.aborted) return resolve();
      if (this.stores.ui.get().inputs.started === "1") return resolve();
      const finish = () => {
        unsub();
        this.signal.removeEventListener("abort", finish);
        resolve();
      };
      const unsub = this.stores.ui.subscribe(() => {
        if (this.stores.ui.get().inputs.started === "1") finish();
      });
      this.signal.addEventListener("abort", finish, { once: true });
    });
  }

  /** Resolve when the viewer clicks "Replay" (bumps `replayToken`) or on abort. */
  awaitReplay(): Promise<void> {
    return new Promise((resolve) => {
      if (this.signal.aborted) return resolve();
      const start = this.stores.ui.get().replayToken;
      const finish = () => {
        unsub();
        this.signal.removeEventListener("abort", finish);
        resolve();
      };
      const unsub = this.stores.ui.subscribe(() => {
        if (this.stores.ui.get().replayToken !== start) finish();
      });
      this.signal.addEventListener("abort", finish, { once: true });
    });
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

  /** Switch which agent the viewer is looking at (clears its notification).
   *  Background tracks keep streaming, so returning shows the work done while away. */
  setOrg(orgId: string): void {
    this.stores.ui.update((s) => ({
      ...s,
      currentOrg: orgId,
      notified: s.notified.filter((n) => n !== orgId),
    }));
  }

  /** Flag an agent as finished-while-away — shows a sidebar notification dot.
   *  No-op if the viewer is already looking at that agent. */
  notify(agentId: string): void {
    this.stores.ui.update((s) =>
      s.currentOrg === agentId || s.notified.includes(agentId)
        ? s
        : { ...s, notified: [...s.notified, agentId] },
    );
  }

  // ---- ghost cursor -------------------------------------------------------

  /** Show the ghost cursor. Preserves its last position so re-showing glides
   *  from where it was (not a reset point); falls back to bottom-center. */
  showCursor(x?: number, y?: number): void {
    const cur = this.stores.cursor.get();
    const fbX = typeof window !== "undefined" ? window.innerWidth / 2 : 640;
    const fbY = typeof window !== "undefined" ? window.innerHeight - 120 : 600;
    this.stores.cursor.set({
      x: x ?? cur.x ?? fbX,
      y: y ?? cur.y ?? fbY,
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

  // ---- work plan / sprint + PR (inline cards, proxy to main track) --------

  showPlan(title: string, tasks: { title: string; detail?: string }[]) {
    return this.track().showPlan(title, tasks);
  }
  acceptPlan() {
    this.track().acceptPlan();
  }
  setTask(index: number, status: "queued" | "active" | "done") {
    this.track().setTask(index, status);
  }
  openPR(pr: {
    number: number;
    title: string;
    branch: string;
    files: number;
    additions: number;
    deletions: number;
  }) {
    this.track().openPR(pr);
  }
  passPRChecks() {
    this.track().passPRChecks();
  }
  mergePR() {
    this.track().mergePR();
  }
  showDigest() {
    this.track().showDigest();
  }
  connectDigest(channel: "slack" | "teams") {
    this.track().connectDigest(channel);
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Clear all scripted state so the autoplay loop can replay from scratch. */
  reset(): void {
    this.tracks.clear();
    this.stores.resetAll();
  }
}
