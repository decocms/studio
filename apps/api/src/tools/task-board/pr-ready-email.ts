/**
 * "Your task has a PR waiting for you" — the one email a reporter gets.
 *
 * Fired from `parkReviewedCardForHuman`, which is the single transition that
 * means "it is your turn": the agent side of the review is over and the card
 * moved In Progress -> In Review. That transition is already a no-op unless the
 * card is mid-cycle, so one email per review cycle falls out of it — no dedup
 * key, no notification row, no schema change.
 *
 * Deliberately NOT a `notifications` row: the inbox already surfaces the card,
 * and a new row type would cost a CHECK-constraint migration for an email the
 * digest would then have to re-verify at send time. Best-effort, like every
 * other reaction here: a mail failure must never hold a card out of In Review.
 */

import { taskKey } from "@decocms/shared/task-key";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { emailTemplate } from "@/auth/email-template";
import { createEmailSender, findEmailProvider } from "@/auth/email-providers";
import { getConfig } from "@/core/config";
import { getBaseUrl } from "@/core/server-constants";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";

export interface PrLink {
  url: string;
  repo: string;
  number: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Pure, so the copy and the links are unit-tested without a context. */
export function buildPrReadyEmail(params: {
  title: string;
  orgSlug: string;
  keySeq: number;
  prs: PrLink[];
  baseUrl: string;
}): { subject: string; html: string } {
  // Null for a card written before the key backfill: it renders unlinked.
  const key = taskKey(params.orgSlug, params.keySeq);
  const label = key ?? params.title;
  const taskUrl = key
    ? `${params.baseUrl}/${encodeURIComponent(params.orgSlug)}/t/${encodeURIComponent(key)}`
    : null;
  const links = params.prs
    .map(
      (pr) =>
        `<p style="margin:0 0 8px 0;"><a href="${escapeHtml(pr.url)}" style="color:#141413;">Review ${escapeHtml(pr.repo)} #${pr.number}</a></p>`,
    )
    .join("");
  return {
    subject: `${label} is ready for your review`,
    html: emailTemplate({
      preheader: `${label} has a pull request waiting for you.`,
      heading: "Ready for your review",
      subheading: taskUrl
        ? `<a href="${taskUrl}" style="color:#141413;">${escapeHtml(label)}</a> — ${escapeHtml(params.title)}`
        : escapeHtml(params.title),
      body: links,
    }),
  };
}

/** The digest reuses the invitation provider; so does this. Null when the
 *  deployment has no email provider configured — then nothing is sent. */
function resolveSender() {
  const auth = getConfig().auth;
  const providers = auth.emailProviders ?? [];
  const provider = auth.inviteEmailProviderId
    ? findEmailProvider(providers, auth.inviteEmailProviderId)
    : providers[0];
  return provider ? createEmailSender(provider) : null;
}

export async function emailReporterPrReady(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<void> {
  try {
    const settings = await ctx.storage.organizationSettings.get(
      item.organizationId,
    );
    if (!orgFlagEnabled(settings?.flags, "home_task_intake_enabled")) return;
    if (!item.createdBy) return;

    const prs = await ctx.storage.taskBoard.listPrs(
      item.id,
      item.organizationId,
    );
    if (prs.length === 0) return;

    // The reporter must still be a member, and must still have an address.
    const recipient = await ctx.db
      .selectFrom("user")
      .innerJoin("member", "member.userId", "user.id")
      .select("user.email as email")
      .where("user.id", "=", item.createdBy)
      .where("member.organizationId", "=", item.organizationId)
      .executeTakeFirst();
    if (!recipient?.email) return;

    const org = await ctx.db
      .selectFrom("organization")
      .select("slug")
      .where("id", "=", item.organizationId)
      .executeTakeFirst();
    if (!org?.slug) return;

    const sender = resolveSender();
    if (!sender) return;

    const { subject, html } = buildPrReadyEmail({
      title: item.title,
      orgSlug: org.slug,
      keySeq: item.keySeq,
      prs: prs.map((pr) => ({
        url: pr.url,
        repo: `${pr.repoOwner}/${pr.repoName}`,
        number: pr.number,
      })),
      baseUrl: getBaseUrl(),
    });
    await sender({ to: recipient.email, subject, html });
  } catch (err) {
    console.error(`[task-board] PR-ready email for ${item.id} failed`, err);
  }
}
