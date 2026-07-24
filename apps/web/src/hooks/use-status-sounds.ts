import { playSound } from "@deco/ui/lib/sound-engine.ts";
import { question004Sound } from "@deco/ui/lib/question-004.ts";
import { useDecopilotEvents } from "./use-decopilot-events";
import { usePreferences } from "./use-preferences";

const SOUND_STATUSES = new Set(["completed", "failed", "requires_action"]);

/**
 * Subscribe to org-wide SSE thread status events and play corresponding sounds.
 * Mount once at the app layout level.
 */
export function useStatusSounds(orgSlug: string) {
  const [preferences] = usePreferences();

  useDecopilotEvents({
    orgSlug,
    onTaskStatus: (event) => {
      if (!preferences.enableSounds) return;
      if (!SOUND_STATUSES.has(event.data.status)) return;
      playSound(question004Sound.dataUri).catch((err: unknown) => {
        console.warn("[status-sounds] playback failed:", err);
      });
    },
  });
}
