import type { SoundAsset } from "@deco/ui/lib/sound-types.ts";
import { playSound } from "@deco/ui/lib/sound-engine.ts";
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
