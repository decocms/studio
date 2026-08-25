/**
 * The email digest: every 15 seconds, mail each recipient the notifications
 * they haven't read in the app yet, then stamp them.
 *
 * Same shape as `tools/task-board/dbos-archive-sweep.ts`: the scheduler picks
 * ONE pod per tick, the work list is read inside a step so a replay iterates
 * the recorded list rather than a fresh query, and runtime deps come from a
 * module-level registry wired by app boot before `DBOS.launch()`.
 *
 * Ordering matters and DBOS is what makes it safe: a crash between the send
 * step and the stamp step replays the send from its checkpoint instead of
 * re-sending, then stamps. A send that FAILS never checkpoints, so that
 * recipient's leg retries next tick rather than silently dropping.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { getConfig } from "@/core/config";
import { getBaseUrl } from "@/core/server-constants";
import { createEmailSender, findEmailProvider } from "@/auth/email-providers";
import type { Database } from "@/storage/types";
import { buildDigestEmail, type DigestRow } from "./digest-email";
import { NotificationDataSchema } from "./schema";

/** Six fields — the leading one is seconds. */
const DIGEST_CRONTAB = "*/15 * * * * *";

/**
 * The batching window: a burst inside it becomes one email, and a notification
 * still unread when the window closes is mailed on the next tick — so the mail
 * lands within DEBOUNCE_MS + one tick, not five minutes. Ticking faster than
 * the window would only re-check rows the window has not released yet.
 */
const DEBOUNCE_MS = 30_000;

/** Ceiling per tick, across all recipients. A backlog drains next tick. */
const MAX_ROWS_PER_TICK = 500;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface NotificationDigestRuntime {
  db: Kysely<Database>;
}

let runtime: NotificationDigestRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setNotificationDigestRuntime(
  rt: NotificationDigestRuntime,
): void {
  runtime = rt;
}

function requireRuntime(): NotificationDigestRuntime {
  if (!runtime) {
    throw new Error(
      "[notifications] runtime not initialized — setNotificationDigestRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

interface PendingRow extends DigestRow {
  userId: string;
  email: string;
}

/**
 * The `member` inner join is not decoration: without it a removed member keeps
 * unread rows they can no longer open in-app — so the rows never get marked
 * read — and the digest keeps mailing them task titles for up to 30 days.
 */
async function loadPending(before: Date): Promise<PendingRow[]> {
  const rows = await requireRuntime()
    .db.selectFrom("notifications as n")
    .innerJoin("organization as o", "o.id", "n.organization_id")
    .innerJoin("user as u", "u.id", "n.user_id")
    .innerJoin("member as m", (join) =>
      join
        .onRef("m.userId", "=", "n.user_id")
        .onRef("m.organizationId", "=", "n.organization_id"),
    )
    .select([
      "n.id as id",
      "n.user_id as userId",
      "n.type as type",
      "n.data as data",
      "o.slug as orgSlug",
      "u.email as email",
    ])
    .where("n.emailed_at", "is", null)
    .where("n.read_at", "is", null)
    .where("n.created_at", "<", before)
    .orderBy("n.created_at", "asc")
    .limit(MAX_ROWS_PER_TICK)
    .execute();

  return rows.map((row) => {
    const data = NotificationDataSchema.parse(row.data);
    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      type: row.type,
      orgSlug: row.orgSlug,
      taskTitle: data.taskTitle,
      taskKeySeq: data.taskKeySeq,
      actorName: data.actorName,
    };
  });
}

function groupByRecipient(rows: PendingRow[]): PendingRow[][] {
  const byUser = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId);
    if (list) list.push(row);
    else byUser.set(row.userId, [row]);
  }
  return [...byUser.values()];
}

/** Null when the deployment has no email provider — nothing is loaded, nothing
 *  is stamped, so the rows go out whenever one is configured.
 *
 *  The digest reuses the invitation provider — one configured sender, no new
 *  provider abstraction and no new env var. */
function resolveSender() {
  const auth = getConfig().auth;
  const providers = auth.emailProviders ?? [];
  const provider = auth.inviteEmailProviderId
    ? findEmailProvider(providers, auth.inviteEmailProviderId)
    : providers[0];
  return provider ? createEmailSender(provider) : null;
}

async function sendOne(rows: PendingRow[]): Promise<void> {
  const sender = resolveSender();
  if (!sender) throw new Error("no email provider configured");
  const { subject, html } = buildDigestEmail(rows, getBaseUrl());
  await sender({ to: rows[0]!.email, subject, html });
}

async function stampEmailed(ids: string[]): Promise<void> {
  await requireRuntime()
    .db.updateTable("notifications")
    .set({ emailed_at: new Date() })
    .where("id", "in", ids)
    .execute();
}

async function pruneOld(before: Date): Promise<void> {
  await requireRuntime()
    .db.deleteFrom("notifications")
    .where("created_at", "<", before)
    .execute();
}

async function digestWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const before = new Date(scheduledTime.getTime() - DEBOUNCE_MS);
  const pending = resolveSender()
    ? await DBOS.runStep(() => loadPending(before), {
        name: "loadPendingNotifications",
      })
    : [];

  for (const rows of groupByRecipient(pending)) {
    const userId = rows[0]!.userId;
    try {
      await DBOS.runStep(() => sendOne(rows), { name: `sendDigest:${userId}` });
      await DBOS.runStep(() => stampEmailed(rows.map((row) => row.id)), {
        name: `stampEmailed:${userId}`,
      });
    } catch (err) {
      console.warn(
        `[notifications] digest for ${userId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Retention is a whole-table DELETE and the tick is 15s — hourly is plenty.
  // Derived from `scheduledTime`, so a replay makes the same choice.
  if (
    scheduledTime.getUTCMinutes() === 37 &&
    scheduledTime.getUTCSeconds() < 15
  ) {
    await DBOS.runStep(
      () => pruneOld(new Date(scheduledTime.getTime() - RETENTION_MS)),
      { name: "pruneOldNotifications" },
    );
  }
}

let registeredWorkflow: typeof digestWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerNotificationDigestWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(digestWorkflowFn, {
    name: "notificationDigestWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "notificationDigestWorkflow",
    crontab: DIGEST_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
