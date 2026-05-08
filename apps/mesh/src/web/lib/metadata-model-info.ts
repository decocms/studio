import type { AiProviderModel } from "../hooks/collections/use-ai-providers";
import type { MetadataModelInfo } from "../components/chat/types";

export function toMetadataModelInfo(model: AiProviderModel): MetadataModelInfo {
  const caps = model.capabilities;
  const capabilities =
    caps && caps.length > 0
      ? {
          vision:
            caps.includes("vision") || caps.includes("image") || undefined,
          text: caps.includes("text") || undefined,
          reasoning: caps.includes("reasoning") || undefined,
          file: caps.includes("file") || undefined,
        }
      : undefined;
  return {
    id: model.modelId,
    title: model.title,
    provider: model.providerId,
    capabilities,
    limits: model.limits
      ? {
          contextWindow: model.limits.contextWindow,
          maxOutputTokens: model.limits.maxOutputTokens ?? undefined,
        }
      : undefined,
  };
}
