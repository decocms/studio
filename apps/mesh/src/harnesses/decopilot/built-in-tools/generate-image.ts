/**
 * generate_image Built-in Tool
 *
 * Thin cluster adapter around the portable image-generation tool. Cluster
 * passes Studio's provider/object-storage/local-mode surfaces; desktop passes
 * resolved provider secrets and remote object storage directly.
 */

import type { UIMessageStreamWriter } from "ai";
import type { MeshProvider } from "@/ai-providers/types";
import type { StudioContext } from "@/core/studio-context";
import { getSettings } from "@/settings";
import type { ModelInfo } from "../../../api/routes/decopilot/types";
import {
  createPortableGenerateImageTool,
  type GenerateImageInput,
} from "./portable-media-tools";

export type { GenerateImageInput };

export function createGenerateImageTool(
  writer: UIMessageStreamWriter,
  params: {
    provider: MeshProvider;
    imageModelInfo: ModelInfo;
    ctx: StudioContext;
  },
) {
  return createPortableGenerateImageTool(writer, {
    provider: params.provider,
    imageModelInfo: params.imageModelInfo,
    objectStorage: params.ctx.objectStorage,
    allowHttpExternalUrls: getSettings().localMode,
  });
}
