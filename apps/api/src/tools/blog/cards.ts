import {
  applyBlogCardPatch,
  BLOG_POST_ID,
  type BlogCard,
  type BlogCardPatch,
  BlogCardPatchSchema,
  BlogCardSchema,
  MAX_BLOG_CARD_BYTES,
} from "@decocms/shared/blog-card";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { resolveHiddenProjectIds } from "../../core/project-scope";
import type { StudioContext } from "../../core/studio-context";
import {
  CAMPAIGNS_DIR,
  CARDS_DIR,
  readBlogCards,
  readBlogRecord,
  recordPath,
  updateBlogRecord,
} from "../../file-storage/blog-state";
import { type OrgFs, OrgFsNotFoundError } from "../../file-storage/org-fs";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { taskRunContextStore } from "../task-board/task-run-context";
import { emitBlogCardDeleted, emitBlogCardUpdated } from "./card-events";
import { resolveSiteProject } from "./site-repo";
import { conflictOrRethrow, resolveBlogScope } from "./state";

/**
 * The content track's cards, for the board and for the agent working each one.
 *
 * A card is a file in the brand folder (`cards/<id>.json`); what it holds is
 * `@decocms/shared/blog-card`. Every write here merges into the stored card
 * and announces itself twice: on the org-fs feed, for a sandbox mounting the
 * folder, and as `blog.card.updated`, for every open board.
 */

const CardIdSchema = z
  .string()
  .regex(
    BLOG_POST_ID,
    "A card id is its post's id: letters, digits, `-` and `_`, starting with a letter or digit, at most 64.",
  );

const CardOutputSchema = z.object({
  card: BlogCardSchema,
  version: z
    .string()
    .describe(
      "The version this card was read or written at. Pass it as BLOG_CARD_UPDATE's `expect` to refuse a write over a change made meanwhile.",
    ),
});

/** Short, lowercase and safe as the tail of a post key and a branch name. */
const mintCardId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

/**
 * The chat whose run is calling, or null for a person.
 *
 * A sandboxed run reaches Studio on its thread's MCP endpoint, which puts the
 * thread here; a run on the platform carries it in the request metadata.
 */
function callerRunThread(ctx: StudioContext): string | null {
  return (
    taskRunContextStore.getStore()?.threadId ?? ctx.metadata?.threadId ?? null
  );
}

/**
 * Why a patch may not land on a card, or null when it may.
 *
 * `runThreadId` is the chat of the run calling, null for a person. A run is
 * the card's agent at work: it fills the card and hands it back for review,
 * and moving a post on to scheduled or published is a person's decision.
 * `generating` is never written here, because only starting a run makes it
 * true.
 */
export function cardPatchRefusal(
  card: Pick<BlogCard, "threadId" | "branch" | "virtualMcpId">,
  patch: BlogCardPatch,
  runThreadId: string | null,
): string | null {
  if (runThreadId && card.threadId !== runThreadId) {
    return "A run writes only its own card, and this one belongs to another chat.";
  }
  if (patch.status === "generating") {
    return "A card starts generating only when BLOG_CARD_RUN starts its run.";
  }
  if (
    runThreadId &&
    (patch.status === "scheduled" || patch.status === "published")
  ) {
    return "Scheduling and publishing are a person's decision. Leave the card in awaiting_review.";
  }
  if (
    patch.virtualMcpId &&
    card.branch &&
    patch.virtualMcpId !== card.virtualMcpId
  ) {
    return "This card's branch is already cut on its site. Create a new card to write for another site.";
  }
  return null;
}

/** A stored card, read as one, with its filename as its id. */
function parseCard(id: string, data: Record<string, unknown>): BlogCard {
  const parsed = BlogCardSchema.safeParse({ ...data, id });
  if (!parsed.success) {
    throw new Error(
      `Card ${id} is not a card this version can read: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
    );
  }
  return parsed.data;
}

function requireCardSize(card: BlogCard): void {
  const bytes = new TextEncoder().encode(JSON.stringify(card)).byteLength;
  if (bytes > MAX_BLOG_CARD_BYTES) {
    throw new Error(
      `The card would be ${bytes} bytes; the limit is ${MAX_BLOG_CARD_BYTES}. Keep the post's body in its draft, not every intermediate result.`,
    );
  }
}

async function requireCampaign(
  orgFs: OrgFs,
  brand: string,
  campaignId: string,
): Promise<void> {
  const campaign = await readBlogRecord(
    orgFs,
    recordPath(brand, CAMPAIGNS_DIR, campaignId),
  );
  if (!campaign) {
    throw new Error(
      `Campaign not found: ${campaignId}. BLOG_STATE_GET lists the brand's campaigns.`,
    );
  }
}

/** Announce a written card to the mounts and to every open board. */
async function announce(organizationId: string, card: BlogCard) {
  emitBlogCardUpdated(organizationId, card);
  await notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH);
}

export const BLOG_CARD_LIST = defineTool({
  name: "BLOG_CARD_LIST",
  description:
    "List the organization's blogpost cards, the content track's board. A card is one post on its way: the hypothesis behind it, its draft as it fills in, and its status (ideas, generating, awaiting_review, scheduled, published). Pass `virtualMcpId` for one site's cards. Newest change first.",
  annotations: {
    title: "List Blogpost Cards",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({
    virtualMcpId: z
      .string()
      .max(256)
      .optional()
      .describe("Only this site's cards."),
  }),

  outputSchema: z.object({ cards: z.array(BlogCardSchema) }),

  modelSummary: (r) => `${r.cards.length} blogpost card(s).`,

  handler: async (input, ctx) => {
    const { orgFs, brand } = await resolveBlogScope(ctx);
    const [records, hidden] = await Promise.all([
      readBlogCards(orgFs, brand),
      resolveHiddenProjectIds(ctx),
    ]);
    const cards = records
      .map(({ id, data }) => BlogCardSchema.safeParse({ ...data, id }))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data)
      .filter(
        (card) =>
          !hidden.has(card.virtualMcpId) &&
          (!input.virtualMcpId || card.virtualMcpId === input.virtualMcpId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { cards };
  },
});

export const BLOG_CARD_GET = defineTool({
  name: "BLOG_CARD_GET",
  description:
    "Read one blogpost card: its hypothesis, its draft so far, its status and stage, and the `version` to pass as BLOG_CARD_UPDATE's `expect`.",
  annotations: {
    title: "Read a Blogpost Card",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({ id: CardIdSchema }),

  outputSchema: CardOutputSchema,

  modelSummary: (r) =>
    `Card ${r.card.id}: ${r.card.status}${r.card.stage ? `, ${r.card.stage}` : ""}.`,

  handler: async (input, ctx) => {
    const { orgFs, brand } = await resolveBlogScope(ctx);
    const read = await readBlogRecord(
      orgFs,
      recordPath(brand, CARDS_DIR, input.id),
    );
    if (!read) throw new Error(`Card not found: ${input.id}`);
    return { card: parseCard(input.id, read.data), version: read.version };
  },
});

export const BLOG_CARD_CREATE = defineTool({
  name: "BLOG_CARD_CREATE",
  description:
    "Create a blogpost card in Ideas, for one of the organization's sites and one of its brand's campaigns. The card's id becomes its post's id and names the branch the post is written on.",
  annotations: {
    title: "Create a Blogpost Card",
    readOnlyHint: false,
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
    campaignId: z
      .string()
      .min(1)
      .max(128)
      .describe("The campaign it belongs to, as BLOG_STATE_GET lists them."),
    prompt: z
      .string()
      .max(2_000)
      .optional()
      .describe("What the person wants the post to explore, in their words."),
    id: CardIdSchema.optional().describe(
      "Mint one to make a retried call refuse instead of creating a second card. Omit and one is minted.",
    ),
  }),

  outputSchema: CardOutputSchema,

  modelSummary: (r) => `Created card ${r.card.id} in ideas.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    await resolveSiteProject(ctx, organizationId, input.virtualMcpId);
    await requireCampaign(orgFs, brand, input.campaignId);

    const id = input.id ?? mintCardId();
    const now = new Date().toISOString();
    const card: BlogCard = {
      id,
      kind: "blogpost",
      status: "ideas",
      virtualMcpId: input.virtualMcpId,
      campaignId: input.campaignId,
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };

    let entry;
    try {
      entry = await orgFs.write(
        HOME_MOUNT_PATH,
        recordPath(brand, CARDS_DIR, id),
        JSON.stringify(card),
        {
          actor,
          contentType: "application/json",
          expect: { absent: true },
        },
      );
    } catch (err) {
      throw conflictOrRethrow(err);
    }
    await announce(organizationId, card);
    return { card, version: entry.contentHash ?? "" };
  },
});

export const BLOG_CARD_UPDATE = defineTool({
  name: "BLOG_CARD_UPDATE",
  description:
    "Change a blogpost card by merging `patch` into it: objects merge, arrays replace, and `null` removes a field. Send only what changed. Without `expect`, a write that lands meanwhile is merged with, not overwritten; with it, the call fails if the card moved since that version. A run writes only its own card and never moves it to scheduled or published, and `generating` is set only by starting a run.",
  annotations: {
    title: "Update a Blogpost Card",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({
    id: CardIdSchema,
    patch: BlogCardPatchSchema,
    expect: z
      .string()
      .max(128)
      .optional()
      .describe("The `version` BLOG_CARD_GET returned."),
  }),

  outputSchema: CardOutputSchema,

  modelSummary: (r) =>
    `Card ${r.card.id} saved: ${r.card.status}${r.card.stage ? `, ${r.card.stage}` : ""}.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    const { patch } = input;
    if (patch.virtualMcpId) {
      await resolveSiteProject(ctx, organizationId, patch.virtualMcpId);
    }
    if (patch.campaignId) {
      await requireCampaign(orgFs, brand, patch.campaignId);
    }
    const runThreadId = callerRunThread(ctx);

    let written;
    try {
      written = await updateBlogRecord(
        orgFs,
        actor,
        recordPath(brand, CARDS_DIR, input.id),
        (stored) => {
          const card = parseCard(input.id, stored);
          const refusal = cardPatchRefusal(card, patch, runThreadId);
          if (refusal) throw new Error(refusal);
          const next = parseCard(
            input.id,
            applyBlogCardPatch(card, patch, new Date().toISOString()),
          );
          requireCardSize(next);
          return next;
        },
        { expect: input.expect },
      );
    } catch (err) {
      if (err instanceof OrgFsNotFoundError) {
        throw new Error(`Card not found: ${input.id}`);
      }
      throw conflictOrRethrow(err);
    }

    const card = written.data as BlogCard;
    await announce(organizationId, card);
    return { card, version: written.entry.contentHash ?? "" };
  },
});

export const BLOG_CARD_DELETE = defineTool({
  name: "BLOG_CARD_DELETE",
  description:
    "Delete a blogpost card. Its chat, its branch and any draft it wrote stay where they are.",
  annotations: {
    title: "Delete a Blogpost Card",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({ id: CardIdSchema }),

  outputSchema: z.object({ id: z.string() }),

  modelSummary: (r) => `Deleted card ${r.id}.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    await orgFs.delete(
      HOME_MOUNT_PATH,
      recordPath(brand, CARDS_DIR, input.id),
      {
        actor,
      },
    );
    emitBlogCardDeleted(organizationId, input.id);
    await notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH);
    return { id: input.id };
  },
});
