import { BLOG_STATE_CONFLICT } from "@decocms/shared/blog-state";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { type OrgFs, OrgFsConflictError } from "../../file-storage/org-fs";
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
  resolveBrandDir,
  writeBlogFiles,
  type BlogWrite,
} from "../../file-storage/blog-state";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { callerRunThread } from "./blog-job";
import { requireBlogAi } from "./feature-flag";
import {
  agentStateWriteRefusal,
  StoredCampaignSchema,
} from "./campaign-record";

/**
 * Reading and writing the blog's editorial state, for a caller with no browser.
 *
 * The state is the organization's: its brand guide, read as the blog's brand,
 * writing rules and formats, and the campaigns kept beside it. The guide is
 * edited on the brand page or as a file, never through here — these tools
 * read it and write only campaigns and their seeds. The file layout and its
 * hazards live in `file-storage/blog-state.ts`; what is here is the contract.
 */

/** Ceilings on one call, so a single write cannot be unbounded. */
const MAX_RECORDS_PER_CALL = 50;
const MAX_REMOVALS_PER_CALL = 50;

/**
 * Payload schemas are `.loose()` on purpose: these files are also written by
 * the CMS, which carries fields this schema does not know about yet, and a
 * strict parse would quietly delete them on every agent write.
 */

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

const LooseRecord = z.record(z.string(), z.unknown());

/** A record's id, which is its file's name. */
export const RecordIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "An id is the file's name: letters, digits, dash and underscore only.",
  );

const RecordListSchema = <T extends z.ZodType>(what: T, noun: string) =>
  z
    .array(
      z.object({
        id: RecordIdSchema.describe(
          `The ${noun}'s own id. Reuse the id BLOG_STATE_GET reported to edit one; mint a UUID for a new one.`,
        ),
        data: what,
      }),
    )
    .max(MAX_RECORDS_PER_CALL)
    .optional();

/**
 * Everything a handler on the brand folder needs settled before it can act:
 * the caller, the flag, and which brand folder is the organization's.
 */
export async function resolveBlogScope(ctx: StudioContext): Promise<{
  organizationId: string;
  orgFs: OrgFs;
  brand: string;
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
    organizationId: organization.id,
    orgFs: ctx.orgFs,
    brand: await resolveBrandDir(
      ctx.orgFs,
      organization.slug ?? organization.id,
    ),
    actor: getUserId(ctx) ?? "system",
  };
}

export function conflictOrRethrow(err: unknown): unknown {
  return err instanceof OrgFsConflictError
    ? new Error(`${BLOG_STATE_CONFLICT} ${err.message}`)
    : err;
}

export const BLOG_STATE_GET = defineTool({
  name: "BLOG_STATE_GET",
  description:
    "Read the organization's blog editorial state: the brand profile, writing rules and post formats, read from its brand guide (`home/brands/<brand>/brand.md`), and the campaigns and seeds kept beside it. Returns `versions` — pass the entries back to BLOG_STATE_SET so a write refuses rather than overwriting an edit made meanwhile. An organization with none of this reads as empty, which is not an error. To change the brand, writing rules or formats, edit the guide's sections.",
  annotations: {
    title: "Read Blog State",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({}),

  outputSchema: z.object({
    brandPath: z
      .string()
      .describe(
        "The brand folder this was read from, `brands/<brand>` in the home volume. Its `brand.md` is the guide.",
      ),
    brand: LooseRecord.nullable().describe(
      "Who the brand is. Null when the brand has no guide yet.",
    ),
    context: LooseRecord.nullable().describe(
      "How this blog is written — tone, dos, don'ts, vocabulary, example sentences.",
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

  handler: async (_input, ctx) => {
    const { orgFs, brand } = await resolveBlogScope(ctx);
    return await readBlogState(orgFs, brand);
  },
});

export const BLOG_STATE_SET = defineTool({
  name: "BLOG_STATE_SET",
  description:
    "Write the organization's blog campaigns and campaign seeds, beside its brand guide. Every field is optional and only what is given is touched. Campaigns and seeds are upserted by id. Pass `expect` from BLOG_STATE_GET's `versions` and a write over something that changed meanwhile is refused instead of landing. The brand, writing rules and formats are the guide's sections and are edited there, not here. A chat never writes here: it changes the campaign it shapes with BLOG_CAMPAIGN_UPDATE.",
  annotations: {
    title: "Write Blog State",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({
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
    const {
      organizationId,
      orgFs,
      brand: target,
      actor,
    } = await resolveBlogScope(ctx);

    const refusal = agentStateWriteRefusal(callerRunThread(ctx), {
      campaigns: input.campaigns?.length ?? 0,
      seeds: input.campaignSeeds?.length ?? 0,
      removals:
        (input.removeCampaigns?.length ?? 0) +
        (input.removeCampaignSeeds?.length ?? 0),
    });
    if (refusal) throw new Error(refusal);

    const expect = input.expect ?? {};
    const conditional = (path: string): BlogWrite["expect"] =>
      expect[path] ? { contentHash: expect[path] } : undefined;

    const writes: BlogWrite[] = [];
    for (const { id, data } of input.campaigns ?? []) {
      const path = recordPath(target, CAMPAIGNS_DIR, id);
      writes.push({ path, data, expect: conditional(path) });
    }
    for (const { id, data } of input.campaignSeeds ?? []) {
      const path = recordPath(target, CAMPAIGN_SEEDS_DIR, id);
      writes.push({ path, data, expect: conditional(path) });
    }

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

    // Announced so a brand page or the content track shows what an agent wrote.
    const touched = [
      ...entries.map((entry) => entry.path),
      ...removedCampaigns.map((id) => recordPath(target, CAMPAIGNS_DIR, id)),
      ...removedSeeds.map((id) => recordPath(target, CAMPAIGN_SEEDS_DIR, id)),
    ];
    if (touched.length > 0) {
      await notifyOrgFsChangeFromServer(
        organizationId,
        HOME_MOUNT_PATH,
        touched,
      );
    }

    return {
      written: entries.map((entry) => ({
        path: entry.path,
        contentHash: entry.contentHash ?? "",
      })),
      removed: [...removedCampaigns, ...removedSeeds],
    };
  },
});
