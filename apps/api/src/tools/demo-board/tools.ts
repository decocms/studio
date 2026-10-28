import { z } from "zod";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { ForbiddenError } from "@/core/access-control";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import { refreshItemPrCards } from "../task-board/prs-get";
import { resetDemoBoard } from "./reset";

/** These are admin tools, and reachable over MCP: the flag is checked here. */
async function demoOrganization(ctx: StudioContext): Promise<string> {
  requireAuth(ctx);
  const organization = requireOrganization(ctx);
  await ctx.access.check();
  const settings = await ctx.storage.organizationSettings.get(organization.id);
  if (!orgFlagEnabled(settings?.flags, "demo_board_reset")) {
    throw new ForbiddenError(
      "The demo board tools need the `demo_board_reset` organization flag",
    );
  }
  return organization.id;
}

const MAX_LIVE_CARDS = 10;

export const DEMO_BOARD_CAPTURE = defineTool({
  name: "DEMO_BOARD_CAPTURE",
  description:
    "Make the task board as it stands the demo org's daily starting point. Every card not archived is frozen with its runs, comments and pull requests; `liveItemIds` name the cards an agent may really run, and keep only the card. Archived cards stay archived. Replaces the previous capture.",
  annotations: {
    title: "Capture Demo Board",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    liveItemIds: z.array(z.string().min(1)).max(MAX_LIVE_CARDS).default([]),
  }),
  outputSchema: z.object({
    capturedAt: z.string(),
    frozenItems: z.number(),
    liveItems: z.number(),
    archivedItems: z.number(),
    threads: z.number(),
  }),
  handler: async (input, ctx) => {
    const organizationId = await demoOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");
    const liveItemIds = [...new Set(input.liveItemIds)];

    const snapshot = await ctx.storage.demoBoard.capture(organizationId, {
      liveItemIds,
      capturedBy: userId,
      readPrCards: async (itemId) => {
        const cards = await refreshItemPrCards(ctx, organizationId, itemId);
        // A card frozen with half its pull request read would show it broken
        // every day; better to fail the capture and try again.
        if (!cards || cards.some((card) => card.state === null)) {
          throw new Error(
            `Couldn't read the pull requests of card ${itemId}; capture again in a minute`,
          );
        }
        return cards;
      },
    });
    return {
      capturedAt: snapshot.capturedAt,
      frozenItems: snapshot.rows.task_board_items.length - liveItemIds.length,
      liveItems: liveItemIds.length,
      archivedItems: snapshot.archivedItemIds.length,
      threads: snapshot.rows.threads.length,
    };
  },
});

export const DEMO_BOARD_RESET = defineTool({
  name: "DEMO_BOARD_RESET",
  description:
    "Return the demo org's task board to its capture now, as the daily reset does: cards and chats created since are deleted, captured cards get their runs back with fresh dates, and pull requests opened by live cards are closed.",
  annotations: {
    title: "Reset Demo Board",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    restoredItems: z.number(),
    deletedItems: z.number(),
    closedPrs: z.number(),
    problems: z.array(z.string()),
    deadPreviewUrls: z.array(z.string()),
  }),
  handler: async (_input, ctx) => {
    const organizationId = await demoOrganization(ctx);
    const result = await resetDemoBoard(ctx, organizationId);
    if (!result) {
      throw new Error("Capture the board with DEMO_BOARD_CAPTURE first");
    }
    return result;
  },
});

export const DEMO_BOARD_STATUS = defineTool({
  name: "DEMO_BOARD_STATUS",
  description:
    "When the demo board was captured, which cards are live, and how the last reset went.",
  annotations: {
    title: "Demo Board Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    status: z
      .object({
        capturedAt: z.string(),
        capturedBy: z.string(),
        frozenItems: z.number(),
        liveItemIds: z.array(z.string()),
        lastResetAt: z.string().nullable(),
        lastResetError: z.string().nullable(),
        deadPreviewUrls: z.array(z.string()),
      })
      .nullable(),
  }),
  handler: async (_input, ctx) => {
    const organizationId = await demoOrganization(ctx);
    return { status: await ctx.storage.demoBoard.getStatus(organizationId) };
  },
});
