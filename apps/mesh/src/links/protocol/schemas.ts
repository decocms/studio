import { z } from "zod";

export const capabilitySchema = z.enum([
  "claude-code",
  "codex",
  "decopilot-sandbox",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const registrationPayloadSchema = z.object({
  machineId: z.string().min(1),
  cliVersion: z.string().min(1),
  protocolVersion: z.number().int().nonnegative(),
  capabilities: z.array(capabilitySchema).min(1),
  /**
   * The operating-system hostname of the linked desktop. Used purely as a
   * human-readable display label in the UI (tooltip, dialog). The
   * collision-detection invariant still keys off `machineId`. Optional so
   * older link daemons remain compatible.
   */
  hostname: z.string().min(1).optional(),
  /**
   * Honored only when the cluster sets MESH_ALLOW_LOCALHOST_LINKS=1.
   * In production the cluster derives the expected Warp domain from
   * the authenticated userSub and ignores any value here.
   */
  tunnelUrl: z.string().url().optional(),
});
export type RegistrationPayload = z.infer<typeof registrationPayloadSchema>;

export const linkEntrySchema = z.object({
  machineId: z.string(),
  /** Human-readable display label sent at registration. See registrationPayloadSchema. */
  hostname: z.string().optional(),
  tunnelUrl: z.string().url(),
  /**
   * The raw bearer secret. Both the cluster and the link sign HMACs
   * with this value — symmetric signing requires identical key material.
   *
   * Security posture: this is treated as a working credential at rest in
   * NATS KV. NATS operators within the cluster's trust boundary can see
   * it; mitigations are (a) 30s TTL bounds leak windows, (b) rotation =
   * re-register. A v2 hardening will encrypt at rest with a cluster KMS
   * key. See spec §"linkSecret at rest" — the Path C symmetric
   * construction it describes is impractical without shipping the cluster
   * signing key to the link, so v1 ships with raw-at-rest.
   */
  linkSecret: z.string(),
  cliVersion: z.string(),
  protocolVersion: z.number().int().nonnegative(),
  capabilities: z.array(capabilitySchema),
  createdAt: z.string().datetime(),
});
export type LinkEntry = z.infer<typeof linkEntrySchema>;

export const registrationResponseSchema = z.object({
  /**
   * Raw bearer secret returned exactly once at registration. The link
   * holds it in process memory; the cluster persists the same raw value
   * (see linkEntrySchema.linkSecret). Lost on re-register.
   */
  linkSecret: z.string(),
});
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

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
  })
  .strip();

export type HarnessStreamInputWire = z.infer<typeof harnessStreamInputSchema>;
