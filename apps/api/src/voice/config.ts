import { z } from "zod";
import type { Settings } from "@/settings/types";

export const VoiceConversationConfigSchema = z.object({
  provider: z.enum(["elevenlabs", "openai"]),
  model: z.string().trim().min(1).max(128),
});
export type VoiceConversationConfig = z.infer<
  typeof VoiceConversationConfigSchema
>;

export type VoiceDefaults = Pick<
  Settings,
  | "voiceConversationProvider"
  | "openaiLiveModel"
  | "elevenlabsConversationModel"
>;

export function resolveVoiceConfig(
  defaults: VoiceDefaults,
  override?: {
    voice_provider: string | null;
    voice_model: string | null;
  } | null,
): VoiceConversationConfig {
  if (override?.voice_model != null && override.voice_provider == null)
    throw new Error("A voice model override requires a provider");
  const provider =
    override?.voice_provider ?? defaults.voiceConversationProvider;
  return VoiceConversationConfigSchema.parse({
    provider,
    model:
      override?.voice_model ??
      (provider === "openai"
        ? defaults.openaiLiveModel
        : defaults.elevenlabsConversationModel),
  });
}
