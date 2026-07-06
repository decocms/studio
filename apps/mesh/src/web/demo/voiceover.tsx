/**
 * Demo Mode — narration.
 *
 * The captions ARE the script: every pill line has a pre-recorded voice-over
 * clip (Maya1 TTS — Apache 2.0, Indian-English voice design, generated
 * on-device → AAC in public/demo/vo/), keyed by the exact caption text. Narration is ON by default; browsers block audio
 * until a user gesture, so the player retries the current line on the first
 * pointer/keydown anywhere (the standard unlock pattern). The toggle mutes.
 *
 * The player is a plain store subscriber created inside the stage's
 * sanctioned lifecycle effect — when the caption changes and narration is
 * on, the matching clip plays (any previous clip stops first).
 */
import { useSyncExternalStore } from "react";
import { VolumeMax, VolumeX } from "@untitledui/icons";
import type { DemoStores } from "./director-stores";

/** caption text → clip. Keys must EXACTLY match the script's captions. */
const VO_FILES: Record<string, string> = {
  "This is deco Studio — the home for your AI agents!": "/demo/vo/vo-01.m4a",
  "Every morning, your agents report on what's new — and what needs you":
    "/demo/vo/vo-02.m4a",
  "Your deco asks each team's agent — in parallel": "/demo/vo/vo-03.m4a",
  "Your agents handle the routine — you make the calls that matter":
    "/demo/vo/vo-04.m4a",
  "The card takes you straight into the team context": "/demo/vo/vo-05.m4a",
  "Top left is your context — the scope you're in, the agent you're talking to":
    "/demo/vo/vo-06.m4a",
  "You land on its operations — everything the agent watches, live":
    "/demo/vo/vo-07.m4a",
  "You say ship it — that's the whole job": "/demo/vo/vo-08.m4a",
  "It audits before shipping, finds a regression — and fixes it itself":
    "/demo/vo/vo-09.m4a",
  "Your teammates see it land — their threads live right beside yours":
    "/demo/vo/vo-10.m4a",
  "Every follow-up becomes a card — assigned to an agent, or a person":
    "/demo/vo/vo-11.m4a",
  "Go one level deeper — every level runs an agent loop, with goals and memory":
    "/demo/vo/vo-12.m4a",
  "Every scope is an MCP URL — take this exact agent to Claude Code, Codex, or anywhere":
    "/demo/vo/vo-13.m4a",
  "Or go one level up — and share your whole team as one MCP":
    "/demo/vo/vo-14.m4a",
  "Even Settings is an agent — its screens are just apps in the preview":
    "/demo/vo/vo-15.m4a",
  "And the logo always takes you back home — to your agents":
    "/demo/vo/vo-16.m4a",
  "You can also connect Claude to your deco — it gets all your teams at once":
    "/demo/vo/vo-17.m4a",
  "It's agents all the way down — same intelligence, only the context changes":
    "/demo/vo/vo-18.m4a",
};

/** Clip length (ms) per file — the Director holds each pill at least this
 *  long so narration NEVER gets cropped by the next line. Clips generated
 *  with Maya1 (Apache 2.0, Indian-English voice design) on-device; durations
 *  are the sample-accurate wav lengths from the generation run. */
export const VO_MS: Record<string, number> = {
  "/demo/vo/vo-01.m4a": 2738,
  "/demo/vo/vo-02.m4a": 3382,
  "/demo/vo/vo-03.m4a": 3202,
  "/demo/vo/vo-04.m4a": 3047,
  "/demo/vo/vo-05.m4a": 2281,
  "/demo/vo/vo-06.m4a": 4234,
  "/demo/vo/vo-07.m4a": 4097,
  "/demo/vo/vo-08.m4a": 2464,
  "/demo/vo/vo-09.m4a": 4333,
  "/demo/vo/vo-10.m4a": 4132,
  "/demo/vo/vo-11.m4a": 4456,
  "/demo/vo/vo-12.m4a": 4657,
  "/demo/vo/vo-13.m4a": 6783,
  "/demo/vo/vo-14.m4a": 4906,
  "/demo/vo/vo-15.m4a": 3521,
  "/demo/vo/vo-16.m4a": 3896,
  "/demo/vo/vo-17.m4a": 3833,
  "/demo/vo/vo-18.m4a": 4482,
};

/** Milliseconds the caption must stay up for its clip (0 if unnarrated). */
export function captionHoldMs(caption: string): number {
  const src = VO_FILES[caption];
  return src ? (VO_MS[src] ?? 0) + 300 : 0;
}

/** ON unless explicitly muted — narration leads the tale by default. */
function isOn(stores: DemoStores): boolean {
  return stores.ui.get().inputs.vo !== "off";
}

/** Subscribe to caption changes and narrate. Returns a cleanup fn. */
export function createVoicePlayer(stores: DemoStores): () => void {
  let lastCaption: string | null = null;
  let current: HTMLAudioElement | null = null;
  let unlocked = false;

  const playCaption = (caption: string | null) => {
    current?.pause();
    current = null;
    if (!caption || !isOn(stores)) return;
    const src = VO_FILES[caption];
    if (!src) return;
    current = new Audio(src);
    current.play().then(
      () => {
        unlocked = true;
      },
      () => {
        /* blocked until a user gesture — the unlock listener retries */
      },
    );
  };

  let lastPaused = false;
  const unsub = stores.ui.subscribe(() => {
    const { caption, inputs } = stores.ui.get();
    // Esc pauses/resumes the clip in flight along with the Director's clock.
    const paused = inputs.paused === "1";
    if (paused !== lastPaused) {
      lastPaused = paused;
      if (paused) current?.pause();
      else current?.play().catch(() => {});
    }
    if (caption === lastCaption) return;
    lastCaption = caption;
    playCaption(caption);
  });

  // Autoplay unlock: on the FIRST gesture anywhere, re-speak the line that's
  // currently on screen so narration starts mid-show instead of never.
  const unlock = () => {
    if (unlocked) return cleanupUnlock();
    unlocked = true;
    cleanupUnlock();
    playCaption(stores.ui.get().caption);
  };
  const cleanupUnlock = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  return () => {
    unsub();
    cleanupUnlock();
    current?.pause();
  };
}

export function VoiceToggle({ stores }: { stores: DemoStores }) {
  const on = useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().inputs.vo !== "off",
    () => stores.ui.get().inputs.vo !== "off",
  );
  return (
    <button
      type="button"
      onClick={() =>
        stores.ui.update((s) => ({
          ...s,
          inputs: { ...s.inputs, vo: on ? "off" : "" },
        }))
      }
      aria-pressed={on}
      aria-label={on ? "Mute narration" : "Enable narration"}
      // Same row as the caption pill (top), anchored right — never over the UI.
      className="absolute right-5 top-6 z-[110] flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-2 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
    >
      {on ? <VolumeMax size={14} /> : <VolumeX size={14} />}
      {on ? "Narration on" : "Narration off"}
    </button>
  );
}
