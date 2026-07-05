/**
 * Demo Mode — external stores (Director state lives OUTSIDE React).
 *
 * Reuses the same `Store<T>` primitive the chat uses
 * (`components/chat/store/store-primitive.ts`) so React subscribes via
 * `useSyncExternalStore` and we never need `useEffect` to drive animation
 * (banned by `plugins/ban-use-effect.js`). The Director (a plain class) owns
 * all timers and mutates these stores; components are pure subscribers.
 *
 * Multiple chat "tracks" are supported (one `Store<DemoChatState>` per track id)
 * so a scenario can render several agent sessions running in parallel — each
 * track feeds its own `<Chat.Messages>` via `DemoChatStreamProvider`.
 *
 * Every `set`/`update` MUST produce new top-level references — `Store.set`
 * bails on `Object.is` equality, so in-place mutation would be silently dropped.
 */
import { Store } from "@/web/components/chat/store/store-primitive";
import type { ChatMessage } from "@/web/components/chat/types";

export type DemoChatStatus = "ready" | "submitted" | "streaming" | "error";

/** The minimal slice the real chat renderers read via `useChatStream()`. */
export interface DemoChatState {
  messages: ChatMessage[];
  status: DemoChatStatus;
}

export interface CursorState {
  /** viewport coordinates (px) */
  x: number;
  y: number;
  /** click pulse currently animating */
  clicking: boolean;
  /** cursor mounted/visible at all */
  visible: boolean;
  /** duration (ms) of the in-flight move — drives the CSS transition */
  moveMs: number;
}

export type PlanTaskStatus = "queued" | "active" | "done";
export interface PlanTask {
  title: string;
  detail?: string;
  status: PlanTaskStatus;
}
export interface PlanState {
  title: string;
  tasks: PlanTask[];
  /** false until the viewer approves; gates execution */
  accepted: boolean;
}
export interface PRState {
  number: number;
  title: string;
  branch: string;
  files: number;
  additions: number;
  deletions: number;
  checks: "running" | "passed";
  merged: boolean;
}
export interface DigestState {
  connected: "slack" | "teams" | null;
}

export interface DemoUiState {
  /** ids of dialogs the director has opened (real components read this) */
  openDialogs: readonly string[];
  /** controlled text for demo inputs/terminals/previews, keyed by id */
  inputs: Readonly<Record<string, string>>;
  /** optional chapter caption shown over the stage */
  caption: string | null;
  /** which agent/workspace the viewer is currently looking at (sidebar nav) */
  currentOrg: string | null;
  /** agent ids with an unseen completion — drives the sidebar notification dot */
  notified: readonly string[];
  /** the demo has finished a full play-through — show the end card */
  ended: boolean;
  /** bumped by the end card's "Replay" button to restart the scenario */
  replayToken: number;
}

const DEFAULT_CHAT: DemoChatState = { messages: [], status: "ready" };

export class DemoStores {
  readonly cursor = new Store<CursorState>({
    x: 0,
    y: 0,
    clicking: false,
    visible: false,
    moveMs: 600,
  });
  readonly ui = new Store<DemoUiState>({
    openDialogs: [],
    inputs: {},
    caption: null,
    currentOrg: null,
    notified: [],
    ended: false,
    replayToken: 0,
  });

  private readonly chats = new Map<string, Store<DemoChatState>>();

  /** Lazily create (and cache) the chat store for a track id. */
  getChat(trackId = "main"): Store<DemoChatState> {
    let store = this.chats.get(trackId);
    if (!store) {
      store = new Store<DemoChatState>({ ...DEFAULT_CHAT });
      this.chats.set(trackId, store);
    }
    return store;
  }

  /** Clear every track + ui/cursor so the autoplay loop can replay clean. */
  resetAll(): void {
    for (const store of this.chats.values()) {
      store.set({ messages: [], status: "ready" });
    }
    // Preserve replayToken (monotonic) so awaitReplay can detect the next
    // bump, plus the viewer's start/narration choices so a replay doesn't
    // re-gate behind the start card or unmute against their will.
    this.ui.update((s) => ({
      openDialogs: [],
      inputs: {
        ...(s.inputs.started ? { started: s.inputs.started } : {}),
        ...(s.inputs.vo ? { vo: s.inputs.vo } : {}),
      },
      caption: null,
      currentOrg: null,
      notified: [],
      ended: false,
      replayToken: s.replayToken,
    }));
    this.cursor.set({
      x: 0,
      y: 0,
      clicking: false,
      visible: false,
      moveMs: 600,
    });
  }
}

export function createDemoStores(): DemoStores {
  return new DemoStores();
}
