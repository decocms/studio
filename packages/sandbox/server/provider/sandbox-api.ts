/**
 * The sandbox API a host of `AgentSandboxProvider` (the control plane) serves
 * to Studio: MCP tools for calls, one SSE route for claim phases, and two
 * callbacks back into Studio for credentials only Studio can mint. Both sides
 * import these schemas, so a change breaks both builds instead of a parse.
 */

import { z } from "zod";
import { SandboxImageSchema } from "@decocms/shared/git-providers";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import type {
  EnsureOptions,
  PodTermination,
  Sandbox,
  SandboxId,
} from "./types";

export const SANDBOX_TOOLS = {
  ensure: "SANDBOX_ENSURE",
  status: "SANDBOX_STATUS",
  delete: "SANDBOX_DELETE",
  lifetime: "SANDBOX_LIFETIME",
  capacity: "SANDBOX_CAPACITY",
  tenantPoolsPush: "SANDBOX_TENANT_POOLS_PUSH",
} as const;

/** `GET <base>/api/sandbox/watch?handle=…`, one `data:` line per `ClaimPhase`. */
export const SANDBOX_WATCH_PATH = "/api/sandbox/watch";

/** Studio routes the host calls, with the same bearer both ways. */
export const SANDBOX_CALLBACK_PATHS = {
  cloneUrl: "/api/sandbox-callbacks/clone-url",
  orgFsConfig: "/api/sandbox-callbacks/org-fs-config",
} as const;

const id = z.string().min(1).max(512);

export const sandboxIdSchema = z.object({
  userId: id,
  projectRef: id,
}) satisfies z.ZodType<SandboxId>;

const tenantSchema = z.object({
  orgId: id,
  userId: id,
  orgSlug: z.string().optional(),
  orgName: z.string().optional(),
  userEmail: z.string().optional(),
  userName: z.string().optional(),
});

const repoSchema = z.object({
  cloneUrl: z.string().min(1).max(4096),
  connectionId: z.string().optional(),
  repositoryId: z.string().optional(),
  userName: z.string(),
  userEmail: z.string(),
  branch: z.string().optional(),
  displayName: z.string().optional(),
  submoduleCredentials: z
    .array(z.object({ host: z.string(), token: z.string() }))
    .optional(),
  directoryName: z.string().optional(),
});

/** `image` is left out: the host's template pins it. */
export const ensureOptionsSchema: z.ZodType<Omit<EnsureOptions, "image">> =
  z.object({
    purpose: z.enum(["interactive", "harness-run"]).optional(),
    sandboxImage: SandboxImageSchema.optional(),
    branch: z.string().optional(),
    repo: repoSchema.optional(),
    extraRepos: z.array(repoSchema).optional(),
    workload: z
      .object({
        runtime: z.enum(["node", "bun", "deno"]),
        packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "deno"]),
        devPort: z.number().int().optional(),
        packageManagerPath: z.string().optional(),
      })
      .optional(),
    cloneOnly: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    tenant: tenantSchema.optional(),
    orgFsConfigJson: z.string().optional(),
  });

export const daemonSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  token: z.string().min(1),
});
export type Daemon = z.infer<typeof daemonSchema>;

export const ensureInputSchema = z.object({
  id: sandboxIdSchema,
  opts: ensureOptionsSchema,
});

export const ensureOutputSchema = z.object({
  handle: z.string().min(1),
  workdir: z.string().min(1),
  previewUrl: z.string().nullable(),
  warmPoolAdopted: z.boolean(),
  daemon: daemonSchema,
}) satisfies z.ZodType<Sandbox & { daemon: Daemon }>;

export const handleInputSchema = z.object({ handle: z.string().min(1) });

export const statusInputSchema = z.object({
  handle: z.string().min(1),
  /** Re-provision an evicted claim before answering. */
  resurrect: z.boolean().optional(),
});

const podTerminationSchema: z.ZodType<PodTermination> = z.object({
  reason: z.string(),
  oomKilled: z.boolean(),
  exitCode: z.number().int().optional(),
  memoryLimit: z.string().optional(),
  evictionMessage: z.string().optional(),
});

export const statusOutputSchema = z.object({
  alive: z.boolean(),
  previewUrl: z.string().nullable(),
  daemon: daemonSchema.nullable(),
  lastTermination: podTerminationSchema.nullable(),
});

/** `graceMs` releases the sandbox after it; without it, the idle TTL is renewed. */
export const lifetimeInputSchema = z.object({
  handle: z.string().min(1),
  graceMs: z.number().int().min(0).optional(),
});

export const emptySchema = z.object({});

export const capacityOutputSchema = z.object({ schedulable: z.boolean() });

export const tenantPoolsPushInputSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().min(1),
});
export const tenantPoolsPushOutputSchema = z.object({
  pools: z.array(z.string()),
});

/** A failed tool call's text: this JSON, so the client can branch on `code`. */
export const toolErrorSchema = z.object({
  code: z.enum(["bootstrap-rejected", "internal"]),
  error: z.string(),
  status: z.number().int().optional(),
});
export type ToolError = z.infer<typeof toolErrorSchema>;

const since = z.number();
export const claimPhaseSchema: z.ZodType<ClaimPhase> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("claiming"), since }),
    z.object({
      kind: z.literal("waiting-for-capacity"),
      since,
      message: z.string().optional(),
      nodeClaim: z.string().optional(),
    }),
    z.object({ kind: z.literal("pulling-image"), since }),
    z.object({ kind: z.literal("starting-container"), since }),
    z.object({ kind: z.literal("warming-daemon"), since }),
    z.object({ kind: z.literal("ready") }),
    z.object({
      kind: z.literal("failed"),
      reason: z.enum([
        "image-pull-backoff",
        "crash-loop-backoff",
        "scheduling-timeout",
        "claim-never-created",
        "reconciler-error",
        "unknown",
      ]),
      message: z.string(),
    }),
  ],
);

export const cloneUrlRequestSchema = z
  .object({
    cloneUrl: z.url({ protocol: /^https?$/ }).max(4096),
    connectionId: z.string().min(1).optional(),
    repositoryId: z.string().min(1).optional(),
    /** Absent for a tenant pool's pod. */
    tenant: tenantSchema.optional(),
    bufferMs: z.number().int().nonnegative().optional(),
  })
  .refine((r) => r.connectionId !== undefined || r.repositoryId !== undefined, {
    message: "connectionId or repositoryId is required",
  });
export const cloneUrlResponseSchema = z.object({
  cloneUrl: z.string().nullable(),
});

export const orgFsConfigRequestSchema = z.object({ tenant: tenantSchema });
export const orgFsConfigResponseSchema = z.object({
  orgFsConfigJson: z.string().nullable(),
});
