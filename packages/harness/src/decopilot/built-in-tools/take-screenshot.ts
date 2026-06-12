/**
 * take_screenshot Built-in Tool
 *
 * Thin cluster adapter around the portable Browserless screenshot tool.
 */

import type { UIMessageStreamWriter } from "ai";
import type { ObjectStorageHooks } from "../../harness-deps";
import {
  createPortableTakeScreenshotTool,
  type TakeScreenshotInput,
} from "./portable-media-tools";
import type { PendingImage } from "./vm-tools/types";

export type { PendingImage, TakeScreenshotInput };

export function createTakeScreenshotTool(
  writer: UIMessageStreamWriter,
  params: {
    // Nullable: the portable screenshot tool has a data-URI fallback when
    // object storage is unavailable, so cluster passes `ctx.objectStorage`
    // (BoundObjectStorage | null) straight through — behavior-preserving.
    objectStorage: ObjectStorageHooks | null;
    toolOutputMap: Map<string, string>;
    pendingImages: PendingImage[];
  },
) {
  return createPortableTakeScreenshotTool(writer, {
    objectStorage: params.objectStorage,
    toolOutputMap: params.toolOutputMap,
    pendingImages: params.pendingImages,
  });
}
