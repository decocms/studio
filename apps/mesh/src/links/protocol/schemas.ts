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

// v2 contract: per-slot credentialId (no root credential), no `coding`/`title`
// slots, and `.strict()` objects so old-shape inputs are rejected rather than
// silently accepted.
const modelSelectionSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    provider: z.string().nullable().optional(),
    credentialId: z.string(),
    limits: z
      .object({
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

const modelsConfigSchema = z
  .object({
    thinking: modelSelectionSchema.extend({ title: z.string() }),
    fast: modelSelectionSchema.optional(),
    smart: modelSelectionSchema.optional(),
    image: modelSelectionSchema.optional(),
    deepResearch: modelSelectionSchema.optional(),
  })
  .strict();

const secretModelSourceSchema = z.object({
  kind: z.literal("secret"),
  providerId: z.string(),
  apiKey: z.string(),
  modelId: z.string(),
  baseUrl: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const modelSourcesSchema = z
  .object({
    thinking: secretModelSourceSchema,
    fast: secretModelSourceSchema.optional(),
    smart: secretModelSourceSchema.optional(),
    image: secretModelSourceSchema.optional(),
    deepResearch: secretModelSourceSchema.optional(),
  })
  .strict();

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
    /** First-class harness id on the wire (v2). */
    harnessId: z.enum(["decopilot", "claude-code", "codex"]).optional(),
    threadId: z.string(),
    runId: z.string(),
    taskId: z.string(),
    resumeSessionRef: z.string().optional(),
    messages: z.array(chatMessageSchema),
    /** Symbolic, logically-resolved cwd (see harnesses/workspace-cwd.ts).
     *  Required — its absence rejects pre-v2 inputs. */
    workspace: z.object({ cwd: z.string().min(1) }).strict(),
    models: modelsConfigSchema,
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
