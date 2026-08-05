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
 *
 * `done` marks the run's LAST frame, and the daemon always sends one — clean
 * finish, crash or cancel. A body that ends without it means the connection
 * broke, not the run: the pod is gone mid-turn and the turn has to be continued
 * elsewhere. Without this flag those two are indistinguishable, and continuing a
 * run that actually finished duplicates its work (a second pull request, for
 * one).
 */
export const harnessRunResultSchema = z.object({
  chunks: z.array(z.unknown()),
  done: z
    .boolean()
    .nullish()
    .transform((d) => d ?? false),
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
      // Optional: a task run can be dispatched into the (empty) working
      // directory before its repo is chosen — see HarnessWorkspace.
      repo: z
        .object({
          owner: z.string(),
          name: z.string(),
          connectedGithub: z.boolean(),
        })
        .strict()
        .optional(),
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
      .object({
        id: z.string(),
        instructions: z.string().optional(),
        /**
         * Built-in harness tools this run must NOT have (SDK tool names, e.g.
         * `Write`). Absent = the harness's full built-in set. Set per dispatch,
         * not per agent: a reviewer run on the same org agent has to be
         * read-only where the Super Agent's run is not.
         */
        disallowedTools: z.array(z.string()).optional(),
      })
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
    /**
     * Set when this dispatch CONTINUES a turn a previous attempt started and
     * infrastructure cut short — the Studio pod driving it died, or the sandbox
     * did. Absent on a first attempt.
     *
     * The work already done is not in the harness's context (a new pod has no
     * SDK transcript), it is on disk and in git: the same checkout when the pod
     * survived, otherwise a fresh clone of the branch the dying daemon pushed on
     * SIGTERM. So the harness's job here is to READ that state and carry on —
     * never to start the task over.
     */
    resume: z
      .object({
        /** Why the previous attempt stopped, for the prompt and the log. */
        reason: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type HarnessStreamInputWire = z.infer<typeof harnessStreamInputSchema>;
