import { z } from "zod";

export const capabilitySchema = z.enum([
  "claude-code",
  "codex",
  "decopilot-sandbox",
  "body-offload",
]);
export type Capability = z.infer<typeof capabilitySchema>;

// Per-element tolerant: unknown capabilities are dropped, known ones survive.
export const capabilitiesArraySchema = z
  .array(z.string())
  .catch([])
  .transform((arr) =>
    arr.filter((c): c is Capability => capabilitySchema.safeParse(c).success),
  );

export const dispatchSSEEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ui-message-chunk"),
    chunk: z.unknown(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal("done") }),
]);
export type DispatchSSEEvent = z.infer<typeof dispatchSSEEventSchema>;

const chatMessageSchema = z.record(z.string(), z.unknown()); // opaque to link-protocol

const modelsConfigSchema = z.object({
  credentialId: z.string(),
  thinking: z.object({
    id: z.string(),
    title: z.string(),
    provider: z.string().optional(),
  }),
  coding: z.object({ id: z.string(), title: z.string() }).optional(),
  fast: z.object({ id: z.string(), title: z.string() }).optional(),
  image: z.object({ id: z.string(), title: z.string() }).optional(),
  deepResearch: z.object({ id: z.string(), title: z.string() }).optional(),
});

export const harnessStreamInputSchema = z
  .object({
    threadId: z.string(),
    runId: z.string(),
    taskId: z.string(),
    resumeSessionRef: z.string().optional(),
    messages: z.array(chatMessageSchema),
    models: modelsConfigSchema,
    mcp: z.object({
      url: z.string().url(),
      headers: z.record(z.string(), z.string()),
      expiresAt: z.number().int().positive(),
      /**
       * Injected main chat-model secret for desktop decopilot activation.
       * Only present when target.runsIn === "user-desktop" AND harnessId === "decopilot".
       *
       * ⚠️ SECURITY: carries an org provider API key in plaintext over HTTPS.
       * Scoped to the single main chat-completion key only. Never log this field.
       * Hardening follow-up: cluster model-proxy (spec §3.9).
       */
      modelSecret: z
        .object({
          providerId: z.string(),
          apiKey: z.string(),
          baseUrl: z.string().optional(),
          extraHeaders: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
    }),
    mode: z.string(),
    temperature: z.number(),
    toolApprovalLevel: z.string(),
    user: z.object({ id: z.string(), email: z.string() }),
    organizationId: z.string(),
    organizationSlug: z.string().optional(),
    virtualMcp: z.record(z.string(), z.unknown()),
    agent: z.object({ id: z.string() }),
    branch: z.string().nullable().optional(),
    triggerId: z.string().optional(),
    currentThreadTitle: z.string().optional(),
    traceparent: z.string().optional(),
    /**
     * Single-writer fence token for this run (spec §3.5). The desktop
     * presents this on every POST .../stream append. Minted by
     * prepareRun (Phase B), absent on ws-path runs.
     */
    runFenceToken: z.string().optional(),
  })
  .strip();

export type HarnessStreamInputWire = z.infer<typeof harnessStreamInputSchema>;
