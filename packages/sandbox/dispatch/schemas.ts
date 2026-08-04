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

/**
 * One frame of a harness run's output. The body of `POST /_sandbox/dispatch` is
 * a stream of these, newline-delimited, one per step the harness produced —
 * that is what lets Studio persist a long turn as it happens instead of at its
 * end. (Blank lines in the body are the daemon's keepalive; skip them.)
 *
 * `error` appears only on the last frame, and ALONGSIDE `chunks` rather than
 * instead of them: a crash mid-turn still has to surface the work it did, and
 * the consumer's error path is what records the run as failed.
 */
export const harnessRunResultSchema = z.object({
  chunks: z.array(z.unknown()),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullish()
    .transform((e) => e ?? null),
});
export type HarnessRunResult = z.infer<typeof harnessRunResultSchema>;

const chatMessageSchema = z.record(z.string(), z.unknown()); // opaque to link-protocol

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
    capabilities: z
      .object({
        vision: z.boolean().optional(),
        text: z.boolean().optional(),
        reasoning: z.boolean().optional(),
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

const harnessWorkspaceSchema = z.discriminatedUnion("cwd", [
  z
    .object({
      cwd: z.literal("/repo"),
      repo: z
        .object({
          owner: z.string(),
          name: z.string(),
          connectedGithub: z.boolean(),
        })
        .strict(),
      branch: z.string().nullable(),
    })
    .strict(),
  z.object({ cwd: z.null() }).strict(),
]);

export const harnessStreamInputSchema = z
  .object({
    harnessId: z.enum(["decopilot", "claude-code", "codex"]).optional(),
    threadId: z.string(),
    userMessage: chatMessageSchema,
    harness: z.object({ sessionId: z.string().optional() }).strict(),
    workspace: harnessWorkspaceSchema,
    models: modelsConfigSchema,
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
    // Per-run parent agent-loop step cap. absent = PARENT_STEP_LIMIT default.
    maxAgentSteps: z.number().int().optional(),
    user: z.object({ id: z.string(), email: z.string() }).strict(),
    organizationId: z.string(),
    organizationSlug: z.string().optional(),
    agent: z
      .object({ id: z.string(), instructions: z.string().optional() })
      .strict(),
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
  .strict();

export type HarnessStreamInputWire = z.infer<typeof harnessStreamInputSchema>;
