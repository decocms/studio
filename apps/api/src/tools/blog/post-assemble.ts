import { z } from "zod";
import {
  applyLinksToBlocks,
  blockExample,
  buildGeneratedPostPayload,
  type DraftSection,
  newPostId,
  postBodyText,
  postLinkTargets,
  listAuthorRefs,
  listBlogPayloads,
  sectionResolveTypes,
  str,
} from "@decocms/shared/blog";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { readDecofileSnapshot } from "@/decofile/read-decofile";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { readSiteMeta } from "./site-blocks";
import { requireBranch, resolveSiteRepo } from "./site-repo";

/**
 * A drafted post, turned into the blocks this site renders.
 *
 * `BLOG_POST_DRAFT` names blocks by component name and writes props as plain
 * data; the decofile wants a `__resolveType` this site actually uses and a
 * product slot in whichever of four shapes it already stores. That mapping
 * lived in the browser, which is why a post could be written anywhere and
 * saved only from a tab.
 *
 * Separate from `BLOG_POST_WRITE` rather than folded into it. The transform is
 * pure, so it is worth being able to run and read without committing
 * anything — and the one thing an agent should never do unseen is write to a
 * branch.
 *
 * Returns `bodyText` because the internal-link pass needs the body as prose
 * and prose only exists once the sections are blocks. Call once to get the
 * text, run `BLOG_LINK_SUGGEST` on it, call again with `links`: two runs of a
 * pure function against one decofile read.
 */

const MAX_SECTIONS = 40;
const MAX_LINKS = 20;
const MAX_NAME_CHARS = 200;
const MAX_BODY_CHARS = 20_000;

const SectionSchema = z.object({
  type: z
    .string()
    .max(MAX_NAME_CHARS)
    .describe("The block's name, exactly as BLOG_SITE_BLOCKS gave it."),
  props: z.record(z.string(), z.unknown()),
  productIds: z
    .array(z.string().max(MAX_NAME_CHARS))
    .default([])
    .describe("For a product block only, in order. Empty for every other."),
});

export const BLOG_POST_ASSEMBLE = defineTool({
  name: "BLOG_POST_ASSEMBLE",
  description:
    "Turn a drafted post into the block this site stores: each section mapped onto the site's own `__resolveType`, product ids written in the shape that site uses, unresolved image placeholders cleared and a slug nothing has taken. Returns the payload for BLOG_POST_WRITE, the body as plain text for BLOG_LINK_SUGGEST, and the site's other posts as link targets. Persists nothing.",
  annotations: {
    title: "Assemble a Blog Post",
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
      .describe("The site whose blocks this post is built from."),
    draft: z
      .object({
        title: z.string().max(MAX_NAME_CHARS),
        excerpt: z.string().max(MAX_BODY_CHARS),
        seo: z.object({
          title: z.string().max(MAX_NAME_CHARS),
          description: z.string().max(MAX_BODY_CHARS),
        }),
        cover: z.object({
          url: z
            .string()
            .max(MAX_BODY_CHARS)
            .describe(
              "The cover's address, from BLOG_POST_ILLUSTRATE. Empty is allowed; the post simply has no cover.",
            ),
          alt: z.string().max(MAX_BODY_CHARS),
        }),
        categorySlugs: z.array(z.string().max(MAX_NAME_CHARS)).default([]),
        authorEmails: z.array(z.string().max(MAX_NAME_CHARS)).default([]),
        sections: z.array(SectionSchema).max(MAX_SECTIONS),
      })
      .describe(
        "The post as BLOG_POST_DRAFT wrote it, with `cover.url` filled by whoever drew it.",
      ),
    postId: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Reuse the id from a previous call so the second pass assembles the same post. A fresh one is minted when absent.",
      ),
    links: z
      .array(
        z.object({
          quote: z.string().max(MAX_BODY_CHARS),
          slug: z.string().max(MAX_NAME_CHARS),
        }),
      )
      .max(MAX_LINKS)
      .default([])
      .describe(
        "Accepted suggestions from BLOG_LINK_SUGGEST. A quote whose span crosses an inline tag is skipped rather than wrapped; `applied` says how many landed.",
      ),
    planning: z
      .object({
        campaignKey: z.string().max(MAX_NAME_CHARS).optional(),
        format: z
          .object({
            name: z.string().max(MAX_NAME_CHARS),
            value: z.string().max(MAX_BODY_CHARS),
          })
          .optional(),
        brief: z.string().max(MAX_BODY_CHARS).optional(),
      })
      .optional()
      .describe(
        "Why this post exists: the campaign, the format, and the angle in the operator's own words. Kept on the card, so what was executed keeps its origin.",
      ),
    branch: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Which branch to read the site from. Defaults to the branch the calling thread is pinned to.",
      ),
  }),

  outputSchema: z.object({
    postId: z.string(),
    post: z
      .record(z.string(), z.unknown())
      .describe("Pass straight to BLOG_POST_WRITE as `post`."),
    bodyText: z
      .string()
      .describe("The body as prose. Pass to BLOG_LINK_SUGGEST as `body`."),
    posts: z
      .array(z.object({ title: z.string(), slug: z.string() }))
      .describe(
        "The site's other posts. Pass to BLOG_LINK_SUGGEST as `posts`.",
      ),
    dropped: z
      .number()
      .describe(
        "Sections dropped because this site exposes no block by that name. Not an error, but a shorter post than was written.",
      ),
    applied: z.number().describe("How many of the given links were wrapped."),
    branch: z.string(),
  }),

  modelSummary: (r) =>
    `${r.postId}: ${r.dropped} section(s) dropped, ${r.applied} link(s) applied.`,

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
    const resolveTypes = sectionResolveTypes(meta, { hideDefaults });
    const posts = postLinkTargets(decofile);

    const payload = buildGeneratedPostPayload({
      draft: {
        ...input.draft,
        sections: input.draft.sections as DraftSection[],
      },
      resolveTypes,
      productShapes: Object.fromEntries(
        Object.entries(resolveTypes).map(([name, resolveType]) => [
          name,
          blockExample(resolveType, decofile),
        ]),
      ),
      categories: listBlogPayloads(decofile, "categories").map(
        ({ payload: category }) => ({
          name: str(category.name),
          slug: str(category.slug),
        }),
      ),
      authors: listAuthorRefs(decofile),
      planning: input.planning,
      takenSlugs: posts.map((post) => post.slug),
      now: new Date(),
    });

    const built = (payload.sections ?? []) as Array<Record<string, unknown>>;
    const linked = applyLinksToBlocks(
      built,
      input.links.map((link) => ({
        quote: link.quote,
        href: `/blog/${link.slug}`,
      })),
    );
    payload.sections = linked.blocks;

    return {
      postId: input.postId?.trim() || newPostId(),
      post: payload,
      bodyText: postBodyText(linked.blocks),
      posts,
      dropped: input.draft.sections.length - built.length,
      applied: linked.applied,
      branch,
    };
  },
});
