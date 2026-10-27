import { z } from "zod";
import {
  blocksForFormat,
  type LiveMeta,
  listAuthorRefs,
  listBlogPayloads,
  str,
} from "@decocms/shared/blog";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { readDecofileSnapshot } from "@/decofile/read-decofile";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { requireBranch, resolveSiteRepo, type SiteRepo } from "./site-repo";

/**
 * The blocks a post may be built from, read off the site itself.
 *
 * `BLOG_POST_DRAFT` takes `blocks` and will not invent them: a writer that
 * guesses a prop name produces a section that saves fine and renders empty,
 * which is the worst way to be wrong. Until this existed the only thing that
 * could answer was the CMS, because the mapping lived in the browser's
 * bundle — so an agent could draft a post only if a person had a tab open.
 *
 * Categories and authors come back with it rather than from a second call.
 * They are three reads of one decofile, and a real one is several megabytes;
 * splitting them would mean paying for it three times to answer one question.
 */

const MAX_NAME_CHARS = 200;
const MAX_BODY_CHARS = 20_000;

/** `BLOG_POST_DRAFT`'s own cap. More than it accepts is waste on both ends. */
const MAX_BLOCKS = 40;

const BlockSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  schema: z
    .record(z.string(), z.unknown())
    .describe("The block's JSON Schema. Its props are exactly these."),
  example: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "One of this block as the site already stores it. Where it disagrees with the schema, it is the one that renders.",
    ),
});

export const BLOG_SITE_BLOCKS = defineTool({
  name: "BLOG_SITE_BLOCKS",
  description:
    "The blocks this site can actually render a post out of, each with its own JSON Schema and an example of how the site already stores it, narrowed to the ones a format cites. Returns the blog's categories and authors with them. Pass `blocks` straight into BLOG_POST_DRAFT.",
  annotations: {
    title: "Read the Site's Post Blocks",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    /** Reads this organization's own repository and nothing else. */
    openWorldHint: false,
  },

  inputSchema: z.object({
    virtualMcpId: z
      .string()
      .min(1)
      .max(256)
      .describe("The site whose blocks these are."),
    format: z
      .object({
        name: z.string().max(MAX_NAME_CHARS),
        value: z.string().max(MAX_BODY_CHARS),
      })
      .describe(
        "The format this post will follow. Its `@Name` citations pick which of the site's blocks come back; a format citing none gets all of them.",
      ),
    branch: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Which branch to read. Defaults to the branch the calling thread is pinned to — the one whose editor the person is looking at.",
      ),
  }),

  outputSchema: z.object({
    blocks: z.array(BlockSchema),
    categories: z.array(z.object({ name: z.string(), slug: z.string() })),
    authors: z.array(
      z.object({
        name: z.string(),
        email: z.string(),
        bio: z.string().optional(),
      }),
    ),
    branch: z.string(),
  }),

  modelSummary: (r) =>
    `${r.blocks.length} block(s), ${r.categories.length} categor(ies), ${r.authors.length} author(s) on ${r.branch}.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    await requireBlogAi(ctx, organization.id);

    const site = await resolveSiteRepo(
      ctx,
      organization.id,
      input.virtualMcpId,
    );
    const branch = await requireBranch(ctx, input.branch, "read");

    const [snapshot, meta, settings] = await Promise.all([
      readDecofileSnapshot(site.client, branch, site.packagePath),
      readSiteMeta(site, branch),
      ctx.storage.organizationSettings.get(organization.id),
    ]);

    const decofile = JSON.parse(snapshot.decofile) as Record<string, unknown>;
    const hideDefaults = orgFlagEnabled(
      settings?.flags,
      "hide_default_blog_blocks",
    );

    const blocks = blocksForFormat(input.format, meta, decofile, {
      hideDefaults,
    }).slice(0, MAX_BLOCKS);
    if (blocks.length === 0) {
      throw new Error(
        "This site exposes no blocks a post can be built from. Check that its manifest is committed and that the blog app is installed.",
      );
    }

    return {
      blocks,
      categories: listBlogPayloads(decofile, "categories")
        .map(({ payload }) => ({
          name: str(payload.name),
          slug: str(payload.slug),
        }))
        .filter((category) => category.slug),
      authors: listAuthorRefs(decofile).map(({ name, email, bio }) => ({
        name,
        email,
        ...(str(bio) ? { bio: str(bio) } : {}),
      })),
      branch,
    };
  },
});

const META_BASENAME = ".deco/meta.gen.json";

/**
 * The site's manifest, from the repository rather than from the storefront.
 *
 * A thread's branch may not exist on the remote yet — it forks from default at
 * the first CMS touch — and `meta.gen.json` is a code artifact the CMS never
 * edits, so the default branch's copy is the schema that fork would carry.
 */
export async function readSiteMeta(
  site: SiteRepo,
  branch: string,
): Promise<LiveMeta> {
  const path = site.packagePath
    ? `${site.packagePath}/${META_BASENAME}`
    : META_BASENAME;
  let text = await site.client.readFileAtRef(branch, path);
  if (text === null) {
    const fallback = await site.client.getDefaultBranch();
    if (fallback !== branch) {
      text = await site.client.readFileAtRef(fallback, path);
    }
  }
  if (text === null) {
    throw new Error(
      `This site has no ${META_BASENAME} committed, so there is no schema to write a post against. Build the site once and commit it.`,
    );
  }
  return JSON.parse(text) as LiveMeta;
}
