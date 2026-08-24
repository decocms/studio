/**
 * The batched digest: one email per (user, org) per window, instead of one per
 * change.
 *
 * A boot-time timer, the same shape as `TaskBoardReviewSweeper` — the work has
 * to happen without a request and outside any DBOS workflow. Nothing is queued:
 * `listDueDigests` re-derives who is owed an email from the activity log every
 * tick, so a missed tick costs latency and never correctness.
 *
 * Delivery is at-most-once. The cursor is claimed BEFORE the send
 * (`claimDigest`), so a pod dying mid-send drops that one digest rather than
 * letting N pods send N copies of it. The inbox holds the same updates
 * regardless, which is what makes that the cheaper failure.
 */

import type {
  DigestCandidate,
  NotificationStorage,
} from "@/storage/notifications";
import { getBaseUrl } from "@/core/server-constants";
import {
  createEmailSender,
  findEmailProvider,
  type EmailProviderConfig,
  type SendEmailParams,
} from "@/auth/email-providers";
import {
  type DigestEvent,
  digestSubject,
  groupByTask,
  renderDigest,
} from "./digest-render";

/** How often to look for due digests. */
const DEFAULT_TICK_MS = 60_000;

/** How long the oldest unsent update waits, so a burst becomes one email. The
 *  wait is self-bounding: `oldest` only ages, so a task that never stops
 *  changing still emails once per window. */
const DEFAULT_COALESCE_MS = 5 * 60_000;

/** Digests per tick. A backlog drains over several ticks rather than holding
 *  one connection open for hundreds of sends. */
const DEFAULT_BATCH_SIZE = 50;

export interface TaskDigestWorkerOptions {
  tickMs?: number;
  coalesceMs?: number;
  batchSize?: number;
}

/** Just enough of the auth config to find a sender; passed in so the worker
 *  doesn't reach into Better Auth's module state. */
export interface DigestEmailConfig {
  emailProviders?: EmailProviderConfig[] | null;
  providerId?: string | null;
}

export class TaskDigestWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards a slow tick overlapping the next: the batch is bounded but a
   *  provider's HTTP call is not. */
  private running = false;

  constructor(
    private readonly notifications: NotificationStorage,
    private readonly emailConfig: DigestEmailConfig,
    private readonly options: TaskDigestWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.options.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed so tests can drive a single tick deterministically. Returns how
   *  many digests were sent. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const sendEmail = this.resolveSender();
      if (!sendEmail) return 0;

      const candidates = await this.notifications.listDueDigests(
        this.options.coalesceMs ?? DEFAULT_COALESCE_MS,
        this.options.batchSize ?? DEFAULT_BATCH_SIZE,
      );
      const results = await Promise.allSettled(
        candidates.map((candidate) => this.sendOne(candidate, sendEmail)),
      );
      sent = results.filter((r) => r.status === "fulfilled" && r.value).length;
    } catch (err) {
      console.error("[task-digest] tick failed", err);
    } finally {
      this.running = false;
    }
    return sent;
  }

  /** Resolved once per tick rather than per recipient — the provider is static
   *  config, and a hundred lookups per tick would all return it. */
  private resolveSender(): ((params: SendEmailParams) => Promise<void>) | null {
    const { emailProviders, providerId } = this.emailConfig;
    if (!providerId || !emailProviders?.length) return null;
    const provider = findEmailProvider(emailProviders, providerId);
    return provider ? createEmailSender(provider) : null;
  }

  /** Claim, then load, then send. Loading first would read rows the claim is
   *  about to hide, so the order here is load-bearing. */
  private async sendOne(
    candidate: DigestCandidate,
    sendEmail: (params: SendEmailParams) => Promise<void>,
  ): Promise<boolean> {
    try {
      const won = await this.notifications.claimDigest(
        candidate.userId,
        candidate.organizationId,
        candidate.through,
        candidate.lastEmailedAt,
      );
      if (!won) return false;

      const notifications = await this.notifications.loadDigestEvents(
        candidate.userId,
        candidate.organizationId,
        candidate.through,
      );
      if (notifications.length === 0) return false;

      const nameOf = await this.actorNames(
        candidate.organizationId,
        notifications,
      );
      const events: DigestEvent[] = notifications.map((n) => ({
        taskBoardItemId: n.taskBoardItemId,
        taskTitle: n.taskTitle,
        taskKeySeq: n.taskKeySeq,
        action: n.action,
        actorName: n.actorId ? nameOf(n.actorId) : null,
        data: n.data,
        occurredAt: n.occurredAt,
      }));
      const groups = groupByTask(events);

      await sendEmail({
        to: candidate.userEmail,
        subject: digestSubject(groups, candidate.organizationSlug),
        html: renderDigest({
          groups,
          orgName: candidate.organizationName,
          orgSlug: candidate.organizationSlug,
          baseUrl: getBaseUrl(),
          nameOf,
        }),
      });
      return true;
    } catch (err) {
      console.error(
        `[task-digest] ${candidate.userId}/${candidate.organizationId} failed`,
        err,
      );
      return false;
    }
  }

  /**
   * Display names for everyone who appears in this digest, as one lookup.
   *
   * Covers both the actor of each event and any assignee named inside an
   * `assignee_changed` payload; an id that no longer resolves reads as
   * "someone" downstream rather than leaking a raw id into an email.
   */
  private async actorNames(
    organizationId: string,
    notifications: { actorId: string | null; data: Record<string, unknown> }[],
  ): Promise<(userId: string) => string | null> {
    const ids = new Set<string>();
    for (const n of notifications) {
      if (n.actorId) ids.add(n.actorId);
      const to = n.data.to;
      if (typeof to === "string") ids.add(to);
    }
    if (ids.size === 0) return () => null;

    const byId = await this.notifications.resolveMemberNames(organizationId, [
      ...ids,
    ]);
    return (userId: string) => byId.get(userId) ?? null;
  }
}
