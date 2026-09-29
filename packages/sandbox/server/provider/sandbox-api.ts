/**
 * The sandbox API a host of `AgentSandboxProvider` (the control plane) serves
 * to Studio: MCP tools for calls and one SSE route for claim phases. The host
 * never calls Studio: credentials only Studio can mint arrive with each ensure
 * and on Studio's periodic `SANDBOX_CREDENTIALS_PUSH`. Both sides import these
 * schemas, so a change breaks both builds instead of a parse.
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
  credentialsPush: "SANDBOX_CREDENTIALS_PUSH",
  list: "SANDBOX_LIST",
} as const;

/**
 * `GET <base>/api/sandbox/watch?handle=…`, one `data:` line per `ClaimPhase`,
 * and an SSE comment every `SANDBOX_WATCH_KEEPALIVE_MS` in between, so a
 * client can tell a long phase (a cold image pull) from a lost host.
 */
export const SANDBOX_WATCH_PATH = "/api/sandbox/watch";
export const SANDBOX_WATCH_KEEPALIVE_MS = 15_000;

const id = z.string().min(1).max(512);
const CLONE_URL_MAX = 4096;
const ORG_FS_CONFIG_MAX = 65_536;
/** Epoch ms. */
const expiresAt = z.number().int().positive();

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
  cloneUrl: z.string().min(1).max(CLONE_URL_MAX),
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
  credentialExpiresAt: expiresAt.optional(),
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
    orgFsConfigJson: z.string().max(ORG_FS_CONFIG_MAX).optional(),
  });

export const daemonSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  token: z.string().min(1),
});
export type Daemon = z.infer<typeof daemonSchema>;

export const ensureInputSchema = z.object({
  id: sandboxIdSchema,
  opts: ensureOptionsSchema,
  /**
   * Until when `opts.orgFsConfigJson` stays valid, at least; unset keeps it
   * out of the host's store. Clone credentials carry their own
   * `credentialExpiresAt`.
   */
  credentialsValidUntil: z
    .object({ orgFsConfig: expiresAt.optional() })
    .optional(),
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

const tenantIdsSchema = z.object({ orgId: id, userId: id });

/**
 * A repo as its credential is keyed: by repository record, or by connection
 * and lowercased GitHub `owner/name`, which is what each mint path trusts.
 */
export const repoIdentitySchema = z.union([
  z.object({ repositoryId: id }).strict(),
  z.object({ connectionId: id, repo: id }).strict(),
]);
export type RepoIdentity = z.infer<typeof repoIdentitySchema>;

export const CREDENTIALS_PUSH_MAX = 2_000;

/** `tenant: null` is a tenant pool's credential. */
export const credentialsPushInputSchema = z.object({
  cloneUrls: z
    .array(
      z.object({
        tenant: tenantIdsSchema.nullable(),
        repo: repoIdentitySchema,
        cloneUrl: z.url({ protocol: /^https?$/ }).max(CLONE_URL_MAX),
        expiresAt,
      }),
    )
    .max(CREDENTIALS_PUSH_MAX),
  orgFsConfigs: z
    .array(
      z.object({
        tenant: tenantIdsSchema,
        orgFsConfigJson: z.string().min(1).max(ORG_FS_CONFIG_MAX),
        expiresAt,
      }),
    )
    .max(CREDENTIALS_PUSH_MAX),
});
export type CredentialsPush = z.infer<typeof credentialsPushInputSchema>;
/** `kept`: an entry the host already held with a later expiry, or already expired. */
export const credentialsPushOutputSchema = z.object({
  stored: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
});

export const SANDBOX_LIST_MAX = 5_000;

/** The host's live sandboxes, without credentials. */
export const listOutputSchema = z.object({
  sandboxes: z
    .array(
      z.object({
        handle: id,
        tenant: tenantIdsSchema.nullable(),
        repos: z.array(repoIdentitySchema).max(16),
        /** The sandbox mounts org-fs. */
        orgFs: z.boolean(),
        /** When the org-fs config the host holds for its tenant expires. */
        orgFsConfigExpiresAt: expiresAt.nullable(),
      }),
    )
    .max(SANDBOX_LIST_MAX),
});
export type SandboxListing = z.infer<
  typeof listOutputSchema
>["sandboxes"][number];
