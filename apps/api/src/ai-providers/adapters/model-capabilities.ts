import type { ModelCapability } from "@decocms/shared/sdk";

/**
 * Shared by llmapi and openrouter: both catalogs describe a model's
 * modalities/params in the same OpenRouter-style shape. "image" in input
 * modalities means vision (accepts images), not image generation — remap so
 * it's distinct from output "image".
 */
export function deriveModalityCapabilities(
  inputModalities: string[],
  outputModalities: string[],
  supportedParameters: string[] | null | undefined,
  extraCapabilities: ModelCapability[] = [],
): ModelCapability[] {
  return [
    ...new Set([
      ...inputModalities.map((mod) => (mod === "image" ? "vision" : mod)),
      ...outputModalities,
      ...(supportedParameters?.includes("tools") ? (["tools"] as const) : []),
      ...extraCapabilities,
    ]),
  ] as ModelCapability[];
}
