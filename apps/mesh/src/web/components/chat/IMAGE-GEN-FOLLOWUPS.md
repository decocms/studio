# Image Generation — Follow-up Items

Tracked items deferred from the initial implementation PR.

## 1. Base64 → Object Storage Migration

**Priority:** High
**Impact:** Database bloat, slow thread loading, large SSE payloads

Currently, generated images are stored as base64 data URLs directly in thread message `parts` JSON. A 1024x1024 PNG = 1-5MB per image in the database row.

**Fix:** Upload generated images to object storage (S3/R2) on the server, store only the HTTPS URL in the message parts. Add a size guard (reject images > 5MB decoded) as a stopgap until migration is complete.

## 2. Conversation History Not Sent to Image Model

**Priority:** Medium
**Impact:** Multi-turn image refinement doesn't work

`generateImage()` is stateless — only the current message prompt is sent. Follow-up refinements like "make it darker" or "add a cat" won't have context from prior messages. Each generation is independent.

**Fix:** If multi-turn image generation is desired, switch to `streamText` with output modalities for models that support it (Gemini), or prepend conversation summary to the prompt.

## 3. `toMetadataModelInfo` Doesn't Serialize `image-generation` Capability

**Priority:** Low
**Impact:** Server can't infer from metadata that a conversation used image generation

The `toMetadataModelInfo` helper in `chat-store.ts` maps capabilities to a boolean object but only includes `vision`, `text`, and `reasoning`. The `image-generation` capability is silently dropped.

**Fix:** Add `imageGeneration: caps.includes("image-generation") || undefined` to the capabilities mapping.
