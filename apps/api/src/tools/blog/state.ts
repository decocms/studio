import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { CAMPAIGN_STATUSES } from "@decocms/shared/blog-campaign";
import { BLOG_STATE_CONFLICT } from "@decocms/shared/blog-state";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { OrgFsConflictError } from "../../file-storage/org-fs";
import { resolveCallerProjectScope } from "../../core/project-scope";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import {
  CAMPAIGN_SEEDS_DIR,
  CAMPAIGNS_DIR,
  deleteBlogRecords,
  readBlogState,
  recordPath,
  singletonPath,
  writeBlogFiles,
  type BlogWrite,
  type ProjectRef,
} from "../../file-storage/blog-state";
import { seedProjectAgents } from "../../file-storage/project-agents";
import {
  claimProjectFolderFor,
  persistProjectFolderName,
} from "../virtual/project-folder-ensure";
import { CampaignDraftSchema } from "./campaign-suggest";
import { requireBlogAi } from "./feature-flag";
import {
  BlogBrandSchema,
  BlogGenerationSchema,
  BrandRuleSchema,
} from "./schema";

/**
 * Reading and writing the blog's editorial state, for a caller with no browser.
 *
 * Every generation tool in this folder says "does not persist — the caller
 * saves the result", because the only caller there has ever been is the CMS
 * running in a tab. That is what kept the whole feature tied to an open window:
 * an agent, an automation or a scheduled run can produce a brand profile and
 * has nowhere to put it.
 *
 * These two are that place. The file layout and its hazards live in
 * `file-storage/blog-state.ts`; what is here is the contract — who may ask,
 * what shape is accepted, and what a stale write is told.
 *
 * `expect` rather than last-write-wins on the singletons: brand, writing rules
 * and formats are what a person edits by hand, and a run that overwrites an
 * edit made while it was thinking has destroyed work that was never shown to
 * it. The caller passes back the versions {@link BLOG_STATE_GET} reported and a
 * conflict surfaces as a conflict.
 */

/** Ceilings on one call, so a single write cannot be unbounded. */
const MAX_RECORDS_PER_CALL = 50;
const MAX_REMOVALS_PER_CALL = 50;

/**
 * Payload schemas are `.loose()` on purpose.
 *
 * Zod strips what it does not declare, and these files are also written by the
 * CMS, which carries fields this schema does not know about yet. A strict parse
 * would quietly delete them on every agent write — the field would vanish from
 * the brand profile with nothing in any log saying so.
 */
const BrandPayloadSchema = BlogBrandSchema.partial().loose();
const ContextPayloadSchema = BlogGenerationSchema.partial().loose();
const FormatsPayloadSchema = z
  .object({
    formats: z
      .array(BrandRuleSchema)
      .describe(
        "The shapes of post this blog writes in. `value` is a markdown brief citing the site's sections as @ComponentName.",
      ),
  })
  .loose();

/**
 * A campaign as stored: what the generator proposes, plus the bookkeeping the
 * board keeps. `campaignName` and not `name` because the CMS stores these as
 * decofile blocks too, where `name` is the block's own key.
 */
const StoredCampaignSchema = CampaignDraftSchema.omit({ name: true })
  .extend({
    campaignName: z.string().describe("What someone calls this campaign."),
    seedKey: z
      .string()
      .describe(
        "The seed this campaign was generated from, as `blog-manager/campaign-seeds/<id>`. Empty when it was written by hand.",
      ),
    status: z.enum(CAMPAIGN_STATUSES),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .partial()
  .loose();

const StoredSeedSchema = z
  .object({
    seedName: z.string(),
    keywords: z.array(z.string()),
    prompt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .partial()
  .loose();

const VirtualMcpIdSchema = z
  .string()
  .min(1)
  .max(256)
  .describe("The site's project (virtual MCP). Its folder holds the state.");

const LooseRecord = z.record(z.string(), z.unknown());

const RecordListSchema = <T extends z.ZodType>(what: T, noun: string) =>
  z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(
            /^[A-Za-z0-9_-]+$/,
            "An id is the file's name: letters, digits, dash and underscore only.",
          )
          .describe(
            `The ${noun}'s own id. Reuse the id BLOG_STATE_GET reported to edit one; mint a UUID for a new one.`,
          ),
        data: what,
      }),
    )
    .max(MAX_RECORDS_PER_CALL)
    .optional();

/** The project this call is about, or a refusal naming it. */
async function requireProject(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
): Promise<ProjectRef & { organization_id: string }> {
  const project = await ctx.storage.virtualMcps.findById(
    virtualMcpId,
    organizationId,
  );
  const scope = await resolveCallerProjectScope(ctx);
  if (
    !project ||
    project.organization_id !== organizationId ||
    !isProjectAllowed(scope, project.id)
  ) {
    throw new Error(`Project not found: ${virtualMcpId}`);
  }
  return project;
}

/** Everything a handler in this file needs settled before it can act. */
async function prepare(
  ctx: StudioContext,
  virtualMcpId: string,
): Promise<{
  project: ProjectRef;
  organizationId: string;
  actor: string;
}> {
  requireAuth(ctx);
  const organization = requireOrganization(ctx);
  await ctx.access.check();
  await requireBlogAi(ctx, organization.id);
  if (!ctx.orgFs) {
    throw new Error("Organization filesystem is not configured");
  }
  return {
    project: await requireProject(ctx, organization.id, virtualMcpId),
    organizationId: organization.id,
    actor: getUserId(ctx) ?? "system",
  };
}

/**
 * The project with its folder name pinned on it.
 *
 * Unpinned, {@link singletonPath} derives the folder from the title, so a
 * rename moves where this state is read from.
 */
async function withPinnedFolder(
  ctx: StudioContext,
  organizationId: string,
  project: ProjectRef,
  actor: string,
): Promise<ProjectRef> {
  const pinned = await claimProjectFolderFor(
    ctx,
    organizationId,
    project,
    actor,
  );
  if (!pinned) return project;
  await persistProjectFolderName(
    ctx,
    organizationId,
    project.id,
    pinned,
    actor,
  );
  return {
    ...project,
    metadata: {
      ...(project.metadata as Record<string, unknown> | undefined),
      projectFolderName: pinned,
    },
  };
}

function conflictOrRethrow(err: unknown): unknown {
  return err instanceof OrgFsConflictError
    ? new Error(`${BLOG_STATE_CONFLICT} ${err.message}`)
    : err;
}

export const BLOG_STATE_GET = defineTool({
  name: "BLOG_STATE_GET",
  description:
    "Read a site's blog editorial state from the organization's file library: the brand profile, the writing rules, the post formats, the campaigns and their seeds. Returns `versions` — pass the entries back to BLOG_STATE_SET so a write refuses rather than overwriting an edit made meanwhile. A site that has none of this reads as empty, which is not an error.",
  annotations: {
    title: "Read Blog State",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({ virtualMcpId: VirtualMcpIdSchema }),

  outputSchema: z.object({
    brand: LooseRecord.nullable().describe(
      "Who the brand is. Null when it has not been established yet.",
    ),
    context: LooseRecord.nullable().describe(
      "How this blog is written — tone, instructions, guardrails, categories.",
    ),
    formats: LooseRecord.nullable().describe(
      "`{ formats: { name, value }[] }` — the shapes of post this blog writes.",
    ),
    campaigns: z.array(z.object({ id: z.string(), data: LooseRecord })),
    campaignSeeds: z.array(z.object({ id: z.string(), data: LooseRecord })),
    versions: z
      .record(z.string(), z.string())
      .describe(
        "`path -> content hash` for every file read. Copy the entries for the files you intend to replace into BLOG_STATE_SET's `expect`.",
      ),
  }),

  modelSummary: (r) =>
    `Blog state: ${r.brand ? "brand" : "no brand"}, ${r.context ? "writing rules" : "no writing rules"}, ${r.campaigns.length} campaign(s), ${r.campaignSeeds.length} seed(s).`,

  handler: async (input, ctx) => {
    const { project } = await prepare(ctx, input.virtualMcpId);
    return await readBlogState(ctx.orgFs!, project);
  },
});

export const BLOG_STATE_SET = defineTool({
  name: "BLOG_STATE_SET",
  description:
    "Write a site's blog editorial state to the organization's file library. Every field is optional and only what is given is touched — omitting `brand` leaves the brand alone, it does not clear it. Campaigns and seeds are upserted by id. Pass `expect` from BLOG_STATE_GET's `versions` and a write over something that changed meanwhile is refused instead of landing.",
  annotations: {
    title: "Write Blog State",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({
    virtualMcpId: VirtualMcpIdSchema,
    brand: BrandPayloadSchema.optional().describe(
      "Replaces the brand profile whole. Read it first and send it back changed; a partial object here drops the fields it omits.",
    ),
    context: ContextPayloadSchema.optional().describe(
      "Replaces the writing rules whole, on the same terms as `brand`.",
    ),
    formats: FormatsPayloadSchema.optional().describe(
      "Replaces the format list whole.",
    ),
    campaigns: RecordListSchema(StoredCampaignSchema, "campaign").describe(
      "Campaigns to create or replace, by id. One file each, so writing one never touches another.",
    ),
    campaignSeeds: RecordListSchema(StoredSeedSchema, "seed").describe(
      "Campaign seeds to create or replace, by id.",
    ),
    removeCampaigns: z
      .array(z.string().min(1).max(128))
      .max(MAX_REMOVALS_PER_CALL)
      .optional()
      .describe("Campaign ids to delete. Already gone counts as deleted."),
    removeCampaignSeeds: z
      .array(z.string().min(1).max(128))
      .max(MAX_REMOVALS_PER_CALL)
      .optional()
      .describe("Seed ids to delete."),
    expect: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "`path -> content hash`, copied from BLOG_STATE_GET's `versions`. A path named here whose file changed since makes the whole call fail rather than overwrite. A path left out is written unconditionally.",
      ),
  }),

  outputSchema: z.object({
    written: z
      .array(z.object({ path: z.string(), contentHash: z.string() }))
      .describe(
        "What this call wrote, with the version each file now has. An editor that saves again passes these back as `expect` — without them its next write would be refused against the version it replaced.",
      ),
    removed: z.array(z.string()).describe("Record ids this call deleted."),
  }),

  modelSummary: (r) =>
    `Wrote ${r.written.length} file(s), removed ${r.removed.length} record(s).`,

  handler: async (input, ctx) => {
    const { project, organizationId, actor } = await prepare(
      ctx,
      input.virtualMcpId,
    );
    const orgFs = ctx.orgFs!;
    const target = await withPinnedFolder(ctx, organizationId, project, actor);

    const expect = input.expect ?? {};
    const conditional = (path: string): BlogWrite["expect"] =>
      expect[path] ? { contentHash: expect[path] } : undefined;

    const writes: BlogWrite[] = [];
    for (const which of ["brand", "context", "formats"] as const) {
      const data = input[which];
      if (!data) continue;
      const path = singletonPath(target, which);
      writes.push({ path, data, expect: conditional(path) });
    }
    for (const { id, data } of input.campaigns ?? []) {
      const path = recordPath(target, CAMPAIGNS_DIR, id);
      writes.push({ path, data, expect: conditional(path) });
    }
    for (const { id, data } of input.campaignSeeds ?? []) {
      const path = recordPath(target, CAMPAIGN_SEEDS_DIR, id);
      writes.push({ path, data, expect: conditional(path) });
    }

    /** The roster lands beside the state it works on, once, never rewritten. */
    await seedProjectAgents(orgFs, target, actor);

    let entries: Awaited<ReturnType<typeof writeBlogFiles>>;
    try {
      entries = await writeBlogFiles(orgFs, actor, writes);
    } catch (err) {
      throw conflictOrRethrow(err);
    }

    const removedCampaigns = input.removeCampaigns ?? [];
    const removedSeeds = input.removeCampaignSeeds ?? [];
    await deleteBlogRecords(
      orgFs,
      target,
      actor,
      CAMPAIGNS_DIR,
      removedCampaigns,
    );
    await deleteBlogRecords(
      orgFs,
      target,
      actor,
      CAMPAIGN_SEEDS_DIR,
      removedSeeds,
    );

    return {
      written: entries.map((entry) => ({
        path: entry.path,
        contentHash: entry.contentHash ?? "",
      })),
      removed: [...removedCampaigns, ...removedSeeds],
    };
  },
});
