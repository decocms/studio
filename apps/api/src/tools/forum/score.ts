/**
 * `/score <domain>` in the forum: deco answers a topic with the domain's Deco
 * Score. A published report less than a week old is used as is; otherwise a
 * scan is started and polled. The answer is a comment by the Super Agent, so
 * it lands in the thread, the inbox and the digest like any reply.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";
import { getSettings } from "@/settings";
import { normalizeDomain } from "@decocms/shared/report-seo";
import { sleep } from "@decocms/shared/std";
import type { OnePager } from "@decocms/shared/reports/public-report";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import {
  fetchPublicOnePager,
  getEngineScanStatus,
  onePagerImageUrl,
  startEngineScan,
} from "../reports/public-report";

const FRESH_FOR_MS = 7 * 24 * 3_600_000;
const POLL_EVERY_MS = 15_000;
const POLL_FOR_MS = 15 * 60_000;
const TOP_FIXES = 3;

/** A bare public hostname: labels of letters, digits and hyphens, a dot, and
 *  no port, path or IP. The engine fetches it, so nothing else gets through. */
export function scorableDomain(raw: string): string | null {
  const domain = normalizeDomain(raw);
  if (domain.length > 253) return null;
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    return null;
  }
  return domain;
}

function reportUrl(domain: string): string {
  const base = getSettings().baseUrl ?? "https://studio.decocms.com";
  return `${base.replace(/\/+$/, "")}/report/${encodeURIComponent(domain)}`;
}

/** The reply deco posts: the score, the share card, and what to fix first. */
export function scoreReplyMarkdown(report: OnePager): string {
  const url = reportUrl(report.domain);
  const fixes = report.buckets
    .flatMap((bucket) => bucket.items)
    .slice(0, TOP_FIXES)
    .map((item, i) =>
      `${i + 1}. **${item.title}**. ${item.impact ?? item.description ?? item.why ?? ""}`.trim(),
    );
  return [
    `**${report.domain} scores ${report.score ?? "–"}/100**${report.band ? ` · ${report.band}` : ""}`,
    `![Deco Score for ${report.domain}](${onePagerImageUrl(report.domain)})`,
    ...(fixes.length ? ["**Fix first**", fixes.join("\n")] : []),
    `${report.totals.passed} checks pass and ${report.totals.failed} fail. [Full report](${url})`,
  ].join("\n\n");
}

function scannedRecently(report: OnePager | null, now: number): boolean {
  return (
    !!report?.scanned_at && now - Date.parse(report.scanned_at) < FRESH_FOR_MS
  );
}

/** Wait for a scan to finish, then read what it published. A scan that
 *  cannot start or finish falls back to the last published report, so deco
 *  answers with an older score rather than none. ponytail: polled in-process,
 *  so a pod restart drops it and the topic keeps no answer; move to a DBOS
 *  workflow before this runs at volume. */
async function scoreDomain(domain: string): Promise<OnePager | null> {
  const existing = await fetchPublicOnePager(domain, { lang: "en" });
  if (scannedRecently(existing, Date.now())) return existing;
  try {
    const trigger = await startEngineScan(domain);
    if (trigger.state === "running" && trigger.id) {
      const deadline = Date.now() + POLL_FOR_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_EVERY_MS);
        if ((await getEngineScanStatus(trigger.id)).done) break;
      }
    }
    return (await fetchPublicOnePager(domain, { lang: "en" })) ?? existing;
  } catch (err) {
    if (!existing) throw err;
    console.warn("[forum] /score fell back to the published report", err);
    return existing;
  }
}

async function postReply(
  ctx: StudioContext,
  organizationId: string,
  topicId: string,
  body: string,
) {
  const comment = await ctx.storage.taskBoard.createComment({
    taskBoardItemId: topicId,
    organizationId,
    authorId: SUPER_AGENT_ASSIGNEE_ID,
    body,
  });
  if (!comment) return;
  await ctx.storage.notifications.notify({
    taskBoardItemId: topicId,
    type: "commented",
    actorId: null,
  });
}

export const FORUM_TOPIC_SCORE = defineTool({
  name: "FORUM_TOPIC_SCORE",
  description:
    "Have deco answer a forum topic with a domain's Deco Score. Returns at once; the answer arrives as a reply when the scan is done.",
  annotations: {
    title: "Score a Domain in a Topic",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    topicId: z.string(),
    domain: z.string().min(1).max(300),
  }),
  outputSchema: z.object({ domain: z.string() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId || !getUserId(ctx)) {
      throw new Error("Organization ID required (no active organization)");
    }
    const domain = scorableDomain(input.domain);
    if (!domain) throw new Error(`Not a website domain: ${input.domain}`);
    const topic = await ctx.storage.taskBoard.getById(
      input.topicId,
      organizationId,
    );
    if (!topic) throw new Error("Topic not found");

    void scoreDomain(domain)
      .then((report) =>
        postReply(
          ctx,
          organizationId,
          topic.id,
          report?.scanned_at
            ? scoreReplyMarkdown(report)
            : `I couldn't score **${domain}** yet. [Run it on the report page](${reportUrl(domain)}) and I'll be able to read it.`,
        ),
      )
      .catch((err) => {
        console.error("[forum] /score failed", domain, err);
        return postReply(
          ctx,
          organizationId,
          topic.id,
          `I couldn't score **${domain}** right now. [Try the report page](${reportUrl(domain)}).`,
        );
      });

    return { domain };
  },
});
