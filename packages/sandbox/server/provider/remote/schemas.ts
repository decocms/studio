/**
 * Runtime schemas for the sandbox controller's HTTP API. Each is pinned to the
 * type generated from the Go protocol package, so a field changed there breaks
 * this file's typecheck instead of a response parse in production.
 */

import { z } from "zod";
import type {
  Capability,
  CapacityResponse,
  CloneURLRequest,
  Daemon,
  DrainingResponse,
  EnsureResponse,
  ErrorCode,
  ErrorResponse,
  FailureReason,
  Image,
  OrgFsConfigRequest,
  Phase,
  PhaseKind,
  PodTermination,
  StatusResponse,
  Tenant,
} from "../../../controller-types/sandbox-api";

const capabilitySchema: z.ZodType<Capability> = z.enum([
  "preview",
  "lifecycle-phases",
  "warm-pool",
  "termination-reason",
  "ttl-extend",
  "capacity",
]);

// A capability this build does not know is dropped, not a parse failure: a
// newer controller may declare more than Studio branches on.
const capabilitiesSchema = z.array(z.string()).transform((caps) =>
  caps.flatMap((c) => {
    const parsed = capabilitySchema.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  }),
);

const daemonSchema: z.ZodType<Daemon> = z.object({
  url: z.url({ protocol: /^https?$/ }),
  token: z.string().min(1),
});

const imageSchema: z.ZodType<Image> = z.object({
  requested: z.string(),
  served: z.string(),
});

const podTerminationSchema: z.ZodType<PodTermination> = z.object({
  reason: z.string(),
  oomKilled: z.boolean(),
  exitCode: z.number().int().optional(),
  memoryLimit: z.string().optional(),
  evictionMessage: z.string().optional(),
});

export const ensureResponseSchema: z.ZodType<EnsureResponse> = z.object({
  handle: z.string().min(1),
  workdir: z.string().min(1),
  previewUrl: z.string().nullable(),
  daemon: daemonSchema,
  runtime: z.string(),
  image: imageSchema,
  warmPoolAdopted: z.boolean(),
  capabilities: capabilitiesSchema,
  runtimeMismatch: z.string().optional(),
});

export const statusResponseSchema: z.ZodType<StatusResponse> = z.object({
  handle: z.string().min(1),
  alive: z.boolean(),
  previewUrl: z.string().nullable(),
  daemon: daemonSchema.nullable(),
  runtime: z.string(),
  image: imageSchema.nullable(),
  capabilities: capabilitiesSchema,
  lastTermination: podTerminationSchema.nullable(),
});

export const drainingResponseSchema: z.ZodType<DrainingResponse> = z.object({
  state: z.string(),
});

export const capacityResponseSchema: z.ZodType<CapacityResponse> = z.object({
  schedulable: z.boolean(),
});

const errorCodeSchema: z.ZodType<ErrorCode> = z.enum([
  "bad-request",
  "unknown-handle",
  "handle-conflict",
  "runtime-unreachable",
  "no-runtime",
  "bootstrap-rejected",
  "claim-failed",
  "claim-stalled",
  "daemon-error",
  "internal",
]);

export const errorResponseSchema: z.ZodType<ErrorResponse> = z.object({
  error: z.string(),
  code: errorCodeSchema,
  reasons: z.record(z.string(), z.string()).optional(),
  status: z.number().int().optional(),
});

const phaseKindSchema: z.ZodType<PhaseKind> = z.enum([
  "claiming",
  "waiting-for-capacity",
  "pulling-image",
  "starting-container",
  "warming-daemon",
  "ready",
  "failed",
]);

const failureReasonSchema: z.ZodType<FailureReason> = z.enum([
  "image-pull-backoff",
  "crash-loop-backoff",
  "scheduling-timeout",
]);

export const phaseSchema: z.ZodType<Phase> = z.object({
  kind: phaseKindSchema,
  since: z.number().optional(),
  message: z.string().optional(),
  nodeClaim: z.string().optional(),
  reason: failureReasonSchema.optional(),
});

// The callbacks the controller makes into Studio.

export const cloneUrlRequestSchema: z.ZodType<CloneURLRequest> = z
  .object({
    connectionId: z.string().min(1).optional(),
    repositoryId: z.string().min(1).optional(),
    cloneUrl: z.string().min(1).max(4096),
    bufferMs: z.number().int().nonnegative().optional(),
  })
  .refine((r) => r.connectionId !== undefined || r.repositoryId !== undefined, {
    message: "connectionId or repositoryId is required",
  });

const tenantSchema: z.ZodType<Tenant> = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  orgSlug: z.string().optional(),
  orgName: z.string().optional(),
  userEmail: z.string().optional(),
  userName: z.string().optional(),
});

export const orgFsConfigRequestSchema: z.ZodType<OrgFsConfigRequest> = z.object(
  { tenant: tenantSchema },
);
