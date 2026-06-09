/**
 * take_screenshot Built-in Tool
 *
 * Thin cluster adapter around the portable Browserless screenshot tool.
 */

import type { UIMessageStreamWriter } from "ai";
import type { StudioContext } from "@/core/studio-context";
import {
  createPortableTakeScreenshotTool,
  type TakeScreenshotInput,
} from "./portable-media-tools";
import type { PendingImage } from "./vm-tools/types";

export type { PendingImage, TakeScreenshotInput };

export function createTakeScreenshotTool(
  writer: UIMessageStreamWriter,
  params: {
    ctx: StudioContext;
    toolOutputMap: Map<string, string>;
    pendingImages: PendingImage[];
  },
) {
  return createPortableTakeScreenshotTool(writer, {
    objectStorage: params.ctx.objectStorage,
    toolOutputMap: params.toolOutputMap,
    pendingImages: params.pendingImages,
  });
}
