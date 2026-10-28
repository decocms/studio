import { z } from "zod";
import { BLOG_POST_ID } from "@decocms/shared/blog-card";
import {
  PlaintextSecretError,
  sanitizeSecretsForPersistence,
} from "@decocms/shared/decofile";
import { decofilePatchRefusal } from "@/decofile/block-write-guards";
import { clearSentinels } from "./block-props";
import {
  BlockConflictError,
  decofileQueueKey,
  enqueueDecofilePatch,
} from "@/decofile/commit-coalescer";
import { coAuthorFromStudioContext } from "@/lib/co-author-identity";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { requireBranch, resolveSiteRepo } from "./site-repo";

/**
 * Committing a post the site's agent wrote.
 *
 * Everything else in this folder generates and hands back; the browser was the
 * only thing that could persist, through `PATCH /:virtualMcpId/:branch`. That
 * made a server-side writer impossible — a specialist could draft a post and
 * then had nowhere to put it, so the work died with the run.
 *
 * The draft is written as a *planning* block: `blog-manager/posts/<id>` with no
 * `__resolveType`, which is the form the CMS board reads and the storefront
 * ignores. Publishing stays a human act, and nothing an agent writes here can
 * reach a reader by itself.
 *
 * The queue key is the one the HTTP route uses, deliberately. The coalescer
 * serializes per key, so an agent committing while someone edits the same
 * branch in the editor produces two commits in a line rather than two writers
 * racing for the same head.
 */

/** A post is a document, not a book; past this it is not a blog post. */
const MAX_POST_BYTES = 512_000;

const PLANNING_POST_PREFIX = "blog-manager/posts/";

/** The wrapper a blog post's payload sits under in its block. */
const POST_WRAPPER = "post";

export const BLOG_POST_WRITE = defineTool({
  name: "BLOG_POST_WRITE",
  description:
    "Save a written post to the site as a draft. It lands on the Posts board where a person can read, edit and publish it — never on the live site, whatever its status field says. Pass the payload the CMS stores: title, slug, excerpt, date, image, alt, authors, categories, sections, status, planning.",
  annotations: {
    title: "Save a Blog Draft",
    readOnlyHint: false,
    destructiveHint: false,
    /** Same id, same payload, same block — the write is a set, not an append. */
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({
    virtualMcpId: z
      .string()
      .min(1)
      .max(256)
      .describe("The site whose repository this draft is committed to."),
    postId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The post's id, which is also its key on the board. Reuse one to replace that draft; invent one to add a post.",
      ),
    post: z
      .record(z.string(), z.unknown())
      .describe(
        "The post itself, as the CMS stores it. `sections` carries the rendered body, each entry in the shape the site's own blocks take.",
      ),
    branch: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Which branch to commit to. Defaults to the branch the calling thread is pinned to — the one whose editor the person is looking at. Never the repository's default branch.",
      ),
  }),

  outputSchema: z.object({
    key: z.string().describe("The block this draft was written to."),
    version: z.string().describe("The commit that carries it."),
    branch: z.string().describe("The branch it landed on."),
  }),

  modelSummary: (r) => `Draft saved to ${r.key} on ${r.branch}.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    await requireBlogAi(ctx, organization.id);

    if (!BLOG_POST_ID.test(input.postId)) {
      throw new Error(
        `Invalid post id "${input.postId}": letters, digits, "-" and "_" only.`,
      );
    }

    const site = await resolveSiteRepo(
      ctx,
      organization.id,
      input.virtualMcpId,
    );

    /**
     * Last line of defence. An image sentinel is a note the drafting model
     * left for the illustrator; persisted, it is an image address that renders
     * broken on a published page. Whoever skipped the illustrator, or ran it
     * without a bucket, this is the boundary where it stops.
     */
    const post = clearSentinels(input.post) as Record<string, unknown>;

    const serialized = JSON.stringify(post);
    if (serialized.length > MAX_POST_BYTES) {
      throw new Error(
        `Post is ${serialized.length} bytes; the limit is ${MAX_POST_BYTES}.`,
      );
    }

    const key = `${PLANNING_POST_PREFIX}${input.postId}`;
    let patch;
    try {
      patch = sanitizeSecretsForPersistence({
        set: { [key]: { name: key, [POST_WRAPPER]: post } },
      });
    } catch (err) {
      if (err instanceof PlaintextSecretError) throw new Error(err.message);
      throw err;
    }

    const refusal = decofilePatchRefusal(patch);
    if (refusal) throw new Error(refusal);

    const branch = await requireBranch(ctx, input.branch, "write to");

    try {
      const version = await enqueueDecofilePatch(
        decofileQueueKey(organization.id, site.projectId, branch),
        {
          client: site.client,
          branch,
          packagePath: site.packagePath,
          coAuthor: coAuthorFromStudioContext(ctx),
        },
        patch,
      );
      return { key, version, branch };
    } catch (err) {
      if (err instanceof BlockConflictError) {
        throw new Error(
          `${err.message}. Read the post again and write your changes over the current version.`,
        );
      }
      throw err;
    }
  },
});
