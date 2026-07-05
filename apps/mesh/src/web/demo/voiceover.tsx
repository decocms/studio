/**
 * Demo Mode — narration (trial).
 *
 * Pre-recorded voice-over for the caption pills (macOS `say`, Samantha
 * Enhanced → AAC in public/demo/vo/). OFF by default: browsers block audio
 * until a user gesture, so the floating toggle doubles as the unlock. The
 * player is a plain store subscriber created inside the stage's sanctioned
 * lifecycle effect — when the caption changes and narration is on, the
 * matching clip plays (any previous clip stops first).
 *
 * Trial scope: only the first two captions are recorded.
 */
import { useSyncExternalStore } from "react";
import { VolumeMax, VolumeX } from "@untitledui/icons";
import type { DemoStores } from "./director-stores";

/** caption text → clip. Keep keys EXACTLY in sync with the script. */
const VO_FILES: Record<string, string> = {
  "This is your deco — every org you belong to, as an agent":
    "/demo/vo/vo-your-deco.m4a",
  "Your deco asks each org's pilot — in parallel": "/demo/vo/vo-parallel.m4a",
};

/** Subscribe to caption changes and narrate. Returns an unsubscribe fn. */
export function createVoicePlayer(stores: DemoStores): () => void {
  let lastCaption: string | null = null;
  let current: HTMLAudioElement | null = null;

  const unsub = stores.ui.subscribe(() => {
    const { caption, inputs } = stores.ui.get();
    if (caption === lastCaption) return;
    lastCaption = caption;
    current?.pause();
    current = null;
    if (inputs.vo !== "on" || !caption) return;
    const src = VO_FILES[caption];
    if (!src) return;
    current = new Audio(src);
    // Autoplay may still reject if the unlock gesture hasn't happened.
    current.play().catch(() => {});
  });

  return () => {
    unsub();
    current?.pause();
  };
}

export function VoiceToggle({ stores }: { stores: DemoStores }) {
  const on = useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().inputs.vo === "on",
    () => stores.ui.get().inputs.vo === "on",
  );
  return (
    <button
      type="button"
      onClick={() =>
        stores.ui.update((s) => ({
          ...s,
          inputs: { ...s.inputs, vo: on ? "" : "on" },
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
