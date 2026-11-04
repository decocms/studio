import { z } from "zod";
import {
  asRecord,
  buildBlogPostPreviewUrl,
  buildDraftPointer,
  DRAFT_OFF,
  getBlogPayload,
  type LiveMeta,
  listBlogPayloads,
  livePostKey,
  planningPostKey,
  str,
} from "@decocms/shared/blog";
import {
  draftPreviewServerUrl,
  resolvePreviewServerUrl,
} from "@decocms/shared/deco-site-production-url";
import { signDraftToken } from "@/decofile/draft-token";
import { readDecofileSnapshot } from "@/decofile/read-decofile";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { readSiteMeta } from "./site-blocks";
import { requireBranch, resolveSiteRepo } from "./site-repo";

/**
 * Where a post written on a branch renders, so the run that wrote it can look.
 *
 * The same address the card's Site tab opens: the site's preview server, the
 * post's own route, and a `?__draft=` grant that makes the site pull the
 * branch instead of what is published. A planning post renders there too,
 * because the anonymous pull shows one with a slug as published.
 */

const MAX_EXEMPLARS = 2;

const REASONS = ["no-preview-server", "no-post", "no-route"] as const;

type PreviewReason = (typeof REASONS)[number];

/** The post's address, or why there is none, and the examples' published pages. */
export function postPreviewUrls(args: {
  decofile: Record<string, unknown>;
  meta: LiveMeta | null;
  previewBaseUrl: string | null;
  postId: string;
  exemplarSlugs: readonly string[];
  draftPointer: string;
}): {
  url: string | null;
  reason: PreviewReason | null;
  exemplars: { slug: string; url: string }[];
} {
  const { decofile, meta, previewBaseUrl, postId } = args;
  if (!previewBaseUrl) {
    return { url: null, reason: "no-preview-server", exemplars: [] };
  }
  const posts = listBlogPayloads(decofile, "posts");
  const exemplars = args.exemplarSlugs.flatMap((slug) => {
    const post = posts.find(({ payload }) => str(payload.slug) === slug);
    const url =
      post &&
      buildBlogPostPreviewUrl({
        decofile,
        post: post.payload,
        previewBaseUrl,
        draftPointer: DRAFT_OFF,
        meta,
      });
    return url ? [{ slug, url }] : [];
  });
  const block =
    asRecord(decofile[planningPostKey(postId)]) ??
    asRecord(decofile[livePostKey(postId)]);
  if (!block) return { url: null, reason: "no-post", exemplars };
  const url = buildBlogPostPreviewUrl({
    decofile,
    post: getBlogPayload(block, "posts"),
    previewBaseUrl,
    draftPointer: args.draftPointer,
    meta,
  });
  return url
    ? { url, reason: null, exemplars }
    : { url: null, reason: "no-route", exemplars };
}

export const BLOG_POST_PREVIEW = defineTool({
  name: "BLOG_POST_PREVIEW",
  description:
    "Where a post written on a branch renders on its site: its page on the site's preview server, with a draft grant so the page shows the branch, and the published pages of the posts given as examples. Open them in a browser to see the post as a reader will. `url` is null when the site has no preview server, the branch has no such post, or the site has no route for it; `reason` says which.",
  annotations: {
    title: "Preview a Blog Post",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },

  inputSchema: z.object({
    virtualMcpId: z
      .string()
      .min(1)
      .max(256)
      .describe("The site the post is written for."),
    postId: z
      .string()
      .min(1)
      .max(256)
      .describe("The post's id, which is the card's."),
    branch: z
      .string()
      .max(256)
      .optional()
      .describe("The branch the post is written on: the card's."),
    exemplarSlugs: z
      .array(z.string().max(200))
      .max(MAX_EXEMPLARS)
      .default([])
      .describe(
        "The slugs of the brand's posts to compare against, as BLOG_SITE_BLOCKS returned them in `exemplars`.",
      ),
  }),

  outputSchema: z.object({
    url: z.string().nullable(),
    reason: z.enum(REASONS).nullable(),
    exemplars: z.array(z.object({ slug: z.string(), url: z.string() })),
    version: z.string().describe("The commit the page renders."),
  }),

  modelSummary: (r) =>
    r.url
      ? `The post renders at commit ${r.version.slice(0, 7)}, with ${r.exemplars.length} example(s).`
      : `No preview: ${r.reason}.`,

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
    const branch = await requireBranch(ctx, site, input.branch, "read");
    const [snapshot, meta] = await Promise.all([
      readDecofileSnapshot(site.client, branch, site.packagePath),
      readSiteMeta(site, branch),
    ]);

    const draftPointer = buildDraftPointer({
      apiHost: new URL(ctx.baseUrl).host,
      orgSlug: organization.slug ?? organization.id,
      virtualMcpId: input.virtualMcpId,
      branch,
      token: signDraftToken({
        organizationId: organization.id,
        virtualMcpId: input.virtualMcpId,
        branch,
      }),
      version: snapshot.sha,
    });

    const decofile = JSON.parse(snapshot.decofile) as Record<string, unknown>;
    return {
      ...postPreviewUrls({
        decofile,
        meta,
        previewBaseUrl: draftPreviewServerUrl({
          previewServerUrl: resolvePreviewServerUrl(site.metadata),
          previewHosts: asRecord(decofile.site)?.previewHosts,
          siteName: site.repository.name,
        }),
        postId: input.postId,
        exemplarSlugs: input.exemplarSlugs,
        draftPointer,
      }),
      version: snapshot.sha,
    };
  },
});
