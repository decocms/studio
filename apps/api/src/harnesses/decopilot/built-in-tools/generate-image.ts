/**
 * generate_image Built-in Tool
 *
 * Thin cluster adapter around the portable image-generation tool. Cluster
 * passes Studio's provider/object-storage/local-mode surfaces; desktop passes
 * resolved provider secrets and remote object storage directly.
 */

import type { UIMessageStreamWriter } from "ai";
import type { StudioProvider } from "@/ai-providers/types";
import type { ObjectStorageHooks } from "@/harnesses/lib/harness-deps";
import type { ModelInfo } from "@/harnesses/lib/decopilot/model-info";
import {
  createPortableGenerateImageTool,
  type GenerateImageInput,
} from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";

export type { GenerateImageInput };

export function createGenerateImageTool(
  writer: UIMessageStreamWriter,
  params: {
    provider: StudioProvider;
    imageModelInfo: ModelInfo;
    objectStorage: ObjectStorageHooks;
    allowHttpExternalUrls: boolean;
  },
) {
  return createPortableGenerateImageTool(writer, {
    provider: params.provider,
    imageModelInfo: params.imageModelInfo,
    objectStorage: params.objectStorage,
    allowHttpExternalUrls: params.allowHttpExternalUrls,
  });
}
