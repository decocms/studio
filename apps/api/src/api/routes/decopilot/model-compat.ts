/**
 * Model Compatibility Checks
 *
 * Validates that messages are compatible with model capabilities.
 * Extensible for future checks (vision, tools, context length, etc.).
 */

import type { ModelsConfig } from "./types";
import { HTTPException } from "hono/http-exception";

/** Message shape needed for compatibility checks (supports ChatMessage | ThreadMessage) */
type MessageWithParts = { parts?: Array<{ type: string }> };

/**
 * Validate that messages are compatible with the model's capabilities.
 * Throws HTTPException if incompatible.
 */
export function ensureModelCompatibility(
  models: ModelsConfig,
  messages: MessageWithParts[],
): void {
  const caps = models.thinking.capabilities;
  const modelSupportsFiles = (caps?.vision ?? false) || (caps?.file ?? false);

  if (!modelSupportsFiles) {
    const hasFiles = messages.some((message) =>
      message.parts?.some((part) => part.type === "file"),
    );
    if (hasFiles) {
      throw new HTTPException(400, {
        message:
          "This model does not support file uploads. Please change the model and try again.",
      });
    }
  }

  // Add more checks here as needed (e.g. tools, context length)
}
