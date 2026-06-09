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

const modelSelectionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  provider: z.string().nullable().optional(),
  limits: z
    .object({
      contextWindow: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
});

const modelSelectionWithCredentialSchema = modelSelectionSchema.extend({
  credentialId: z.string().optional(),
});

const modelsConfigSchema = z.object({
  credentialId: z.string(),
  thinking: modelSelectionSchema.extend({ title: z.string() }),
  coding: modelSelectionSchema.optional(),
  fast: modelSelectionSchema.optional(),
  title: modelSelectionSchema.optional(),
  image: modelSelectionWithCredentialSchema.optional(),
  deepResearch: modelSelectionWithCredentialSchema.optional(),
});

const secretModelSourceSchema = z.object({
  kind: z.literal("secret"),
  providerId: z.string(),
  apiKey: z.string(),
  modelId: z.string(),
  baseUrl: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const modelSourcesSchema = z.object({
  primary: secretModelSourceSchema,
  image: secretModelSourceSchema.optional(),
  deepResearch: secretModelSourceSchema.optional(),
  title: secretModelSourceSchema.optional(),
});

const httpMcpSourceSchema = z.object({
  kind: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.number().int().positive(),
});

const objectStorageSourceSchema = z.object({
  kind: z.literal("http"),
  baseUrl: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.number().int().positive(),
});

export const harnessStreamInputSchema = z
  .object({
    threadId: z.string(),
    runId: z.string(),
    taskId: z.string(),
    resumeSessionRef: z.string().optional(),
    messages: z.array(chatMessageSchema),
    models: modelsConfigSchema,
    modelSource: secretModelSourceSchema.optional(),
    modelSources: modelSourcesSchema.optional(),
    mcpSource: httpMcpSourceSchema.optional(),
    objectStorageSource: objectStorageSourceSchema.optional(),
    // Wire input is intentionally HTTP-only. In-process MCP clients are allowed
    // only inside local cluster dispatch and must be normalized to this shape
    // before remote dispatch to the link daemon.
    mcp: z
      .object({
        url: z.string().url(),
        headers: z.record(z.string(), z.string()),
        expiresAt: z.number().int().positive(),
      })
      .strict(),
    mode: z.enum(["default", "plan", "web-search", "gen-image"]),
    temperature: z.number(),
    toolApprovalLevel: z.enum(["auto", "readonly"]),
    // Per-run tool allowlist (model-facing names). null/absent = full toolset.
    toolAllowlist: z.array(z.string()).nullable().optional(),
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
