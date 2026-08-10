import type { SoundAsset } from "@/lib/sounds/sound-types.ts";
import { playSound } from "@/lib/sounds/sound-engine.ts";
import { usePreferences } from "./use-preferences";

/**
 * Returns a play function for a given sound asset.
 * Respects the user's enableSounds preference.
 */
export function useSound(sound: SoundAsset) {
  const [preferences] = usePreferences();

  const play = () => {
    if (!preferences.enableSounds) return;
    playSound(sound.dataUri).catch((err: unknown) => {
      console.warn(`[sound] ${sound.name} playback failed:`, err);
    });
  };

  return play;
}
