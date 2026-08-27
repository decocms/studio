/**
 * The email digest: event-triggered, not polled.
 *
 * A notification enqueues a per-recipient workflow whose id is
 * `notif-digest:<user>:<30s bucket>`, so a burst inside one window collapses
 * onto a single workflow — that dedupe IS the debounce, and it costs nothing
 * when nobody is being notified. The workflow durably sleeps to the end of its
 * window, then mails whatever is still unread. Mail lands ~30s after the first
 * event of a burst instead of on a five-minute tick.
 *
 * The two-minute sweep is the safety net, the same pairing the event bus uses
 * (NotifyStrategy + PollingStrategy): the enqueue happens after the row
 * commits and is rejected outright from inside a DBOS step, so a row whose
 * enqueue never landed must still find a sender. It also carries retention.
 *
 * Both senders CLAIM before sending — one `UPDATE ... WHERE emailed_at IS NULL
 * RETURNING id` — so a sweep that overlaps a per-user workflow cannot mail the
 * same row twice. That is the deliberate inversion of the older send-then-stamp
 * order: with two concurrent senders, a duplicated email is the likelier and
 * worse failure than an email lost to a send that fails after its claim (which
 * the step retries first, and logs if it exhausts them).
 *
 * Runtime deps come from a module-level registry wired by app boot before
 * `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { getConfig } from "@/core/config";
import { getBaseUrl } from "@/core/server-constants";
import { createEmailSender, findEmailProvider } from "@/auth/email-providers";
import type { Database } from "@/storage/types";
import { buildDigestEmail, type DigestRow } from "./digest-email";
import { NotificationDataSchema } from "./schema";

/** Safety net only — the per-recipient workflow is the normal path. */
const SWEEP_CRONTAB = "*/2 * * * *";

/** The batching window: everything a recipient earns inside it is one email. */
const DEBOUNCE_MS = 30_000;

/** How long past its window a row waits before the sweep treats it as orphaned. */
const SWEEP_GRACE_MS = 60_000;

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
function pendingQuery() {
  return requireRuntime()
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
    .orderBy("n.created_at", "asc")
    .limit(MAX_ROWS_PER_TICK);
}

function toPendingRows(
  rows: Awaited<ReturnType<ReturnType<typeof pendingQuery>["execute"]>>,
): PendingRow[] {
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

/** One recipient's unread, unmailed rows — the per-user workflow's work list. */
async function loadPendingForUser(userId: string): Promise<PendingRow[]> {
  return toPendingRows(
    await pendingQuery().where("n.user_id", "=", userId).execute(),
  );
}

/** Rows whose window closed well over a window ago: the sweep's orphans. */
async function loadOrphaned(before: Date): Promise<PendingRow[]> {
  return toPendingRows(
    await pendingQuery().where("n.created_at", "<", before).execute(),
  );
}

/**
 * Take exclusive ownership of these rows for mailing, returning only the ones
 * this caller won. Atomic, so the sweep and a per-user workflow racing over the
 * same rows split them rather than both mailing them.
 *
 * Exported for the integration test — that split is the whole defense against
 * mailing a notification twice, and it only holds against real Postgres.
 */
export async function claimForEmail(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const claimed = await requireRuntime()
    .db.updateTable("notifications")
    .set({ emailed_at: new Date() })
    .where("id", "in", ids)
    .where("emailed_at", "is", null)
    .returning("id")
    .execute();
  return new Set(claimed.map((row) => row.id));
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

async function pruneOld(before: Date): Promise<void> {
  await requireRuntime()
    .db.deleteFrom("notifications")
    .where("created_at", "<", before)
    .execute();
}

/**
 * Claim, then mail, one recipient's batch. Shared by both entry points, so the
 * claim-before-send rule cannot be got right in one and wrong in the other.
 */
async function mailBatch(rows: PendingRow[], label: string): Promise<void> {
  if (rows.length === 0) return;
  const claimed = await DBOS.runStep(
    () => claimForEmail(rows.map((row) => row.id)),
    { name: `claimForEmail:${label}` },
  );
  const mine = rows.filter((row) => claimed.has(row.id));
  if (mine.length === 0) return;
  await DBOS.runStep(() => sendOne(mine), { name: `sendDigest:${label}` });
}

/**
 * One recipient's window. Sleeps to the end of it — durably, so a pod restart
 * resumes the same wait rather than dropping the batch — then mails whatever is
 * still unread, which is every event of the burst plus anything that arrived
 * while it slept.
 */
async function userDigestWorkflowFn(
  userId: string,
  dueAtMs: number,
): Promise<void> {
  const wait = dueAtMs - Date.now();
  if (wait > 0) await DBOS.sleep(wait);
  if (!resolveSender()) return;
  const rows = await DBOS.runStep(() => loadPendingForUser(userId), {
    name: "loadPendingForUser",
  });
  try {
    await mailBatch(rows, userId);
  } catch (err) {
    console.warn(
      `[notifications] digest for ${userId} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The safety net: rows whose enqueue never landed (it runs after the commit,
 * and DBOS rejects it outright from inside a step), plus retention.
 */
async function digestSweepWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const orphanedBefore = new Date(
    scheduledTime.getTime() - DEBOUNCE_MS - SWEEP_GRACE_MS,
  );
  const pending = resolveSender()
    ? await DBOS.runStep(() => loadOrphaned(orphanedBefore), {
        name: "loadOrphanedNotifications",
      })
    : [];

  for (const rows of groupByRecipient(pending)) {
    const userId = rows[0]!.userId;
    try {
      await mailBatch(rows, userId);
    } catch (err) {
      console.warn(
        `[notifications] sweep digest for ${userId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Retention is a whole-table DELETE; hourly is plenty. Derived from
  // `scheduledTime`, so a replay makes the same choice.
  if (scheduledTime.getUTCMinutes() < 2) {
    await DBOS.runStep(
      () => pruneOld(new Date(scheduledTime.getTime() - RETENTION_MS)),
      { name: "pruneOldNotifications" },
    );
  }
}

let registeredSweep: typeof digestSweepWorkflowFn | null = null;
let registeredUserDigest: typeof userDigestWorkflowFn | null = null;

/**
 * Debounce a recipient's mail onto the end of the current 30s window.
 *
 * The workflow id is the whole mechanism: every event for the same recipient in
 * the same window resolves to the same id, and DBOS runs an id once — so a
 * burst of twenty notifications starts one workflow, and the twentieth costs a
 * rejected insert rather than an email.
 *
 * Best-effort by design. `notify()` can run inside a DBOS step (a run reaction
 * writing activity), where `startWorkflow` is illegal — the sweep is what makes
 * that safe, so this logs at debug and returns rather than failing the caller.
 */
export function enqueueUserDigest(userId: string): void {
  if (!registeredUserDigest) return;
  const bucket = Math.floor(Date.now() / DEBOUNCE_MS);
  const dueAtMs = (bucket + 1) * DEBOUNCE_MS;
  void DBOS.startWorkflow(registeredUserDigest, {
    workflowID: `notif-digest:${userId}:${bucket}`,
  })(userId, dueAtMs).catch((err) => {
    // Not a warning: the sweep mails this row within the grace window.
    console.debug(
      "[notifications] digest enqueue skipped:",
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflows. Changing a STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerNotificationDigestWorkflow(): void {
  if (registeredSweep) return;
  registeredUserDigest = DBOS.registerWorkflow(userDigestWorkflowFn, {
    name: "notificationUserDigestWorkflow",
  });
  registeredSweep = DBOS.registerWorkflow(digestSweepWorkflowFn, {
    name: "notificationDigestWorkflow",
  });
  DBOS.registerScheduled(registeredSweep, {
    name: "notificationDigestWorkflow",
    crontab: SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
