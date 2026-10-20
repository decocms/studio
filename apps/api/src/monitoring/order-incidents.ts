/**
 * One card per incident on the org's board: opened when a rule crosses into
 * warning/alert, commented and made urgent on an escalation to alert, closed
 * to Done once ok has held RECOVERY_MS. Every open, escalation and recovery is
 * also an `order_incident` notification to the org's admins, which the digest
 * mails; flapping inside the incident and too-quiet hours are not.
 *
 * The card never starts an agent run: it is created unassigned, and the move to
 * Done is written without a `status_changed` entry, which is what a lane
 * automation fires on.
 */

import { z } from "zod";
import {
  type OrderIncidentNotice,
  orderMonitorChartPath,
  type OrderMonitorVerdict,
} from "@decocms/shared/order-monitor";
import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { getBaseUrl } from "@/core/server-constants";
import type { StudioContext } from "@/core/studio-context";
import { clientFromConnection } from "@/mcp-clients";
import { notify } from "@/notifications/notify";
import type { OrderMonitorStorage } from "@/storage/order-monitor";
import type { Database } from "@/storage/types";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import type { Kysely } from "kysely";
import { localBucketStart } from "./order-lake";
import { listPushes } from "./order-pushes";
import { BUCKETS_PER_DAY, type Rule, type Status } from "./order-rules";

export type IncidentAction = "open" | "update" | "pause" | "close" | "none";

const isIncident = (s: string | undefined) => s === "warning" || s === "alert";

/** How long a rule stays ok before its card closes, so a window flapping on the line keeps one card. */
export const RECOVERY_MS = 30 * 60_000;
/** How long an open waits for VTEX to answer before the card opens unconfirmed. */
const CROSS_CHECK_GRACE_MS = 30 * 60_000;

/**
 * What a tick does to the incident card. A card a person deleted while the
 * incident lasted is not reopened; the next crossing opens one.
 */
export function incidentAction(
  prev: string | undefined,
  next: Status,
  card: {
    hasCard: boolean;
    /** How long `next` has held. */
    heldMs: number;
    /** An open is waiting on the VTEX cross-check. */
    retryOpen?: boolean;
  },
): IncidentAction {
  if (next === "ok") {
    return card.hasCard && card.heldMs >= RECOVERY_MS ? "close" : "none";
  }
  if (isIncident(next) && !card.hasCard && card.retryOpen) return "open";
  if (prev === next) return "none";
  if (isIncident(next)) {
    if (card.hasCard) return "update";
    return isIncident(prev) ? "none" : "open";
  }
  return card.hasCard && isIncident(prev) ? "pause" : "none";
}

/** The store as the board and the UI name it. */
export interface StoreInfo {
  title: string;
  vtexConnectionId: string | null;
  agentIds: string[];
}

/** The ingest install's title, the VTEX connection it is bound to (`state.VTEX`), and the agents that aggregate that one. */
export async function loadStoreInfo(
  ctx: StudioContext,
  storage: OrderMonitorStorage,
  organizationId: string,
  connectionId: string,
): Promise<StoreInfo | null> {
  const install = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );
  if (!install) return null;
  const binding = z
    .object({ VTEX: z.object({ value: z.string() }) })
    .safeParse(install.configuration_state);
  const vtexConnectionId = binding.success ? binding.data.VTEX.value : null;
  const agents = vtexConnectionId
    ? await storage.listAggregatingAgents(organizationId, [vtexConnectionId])
    : [];
  return {
    title: install.title,
    vtexConnectionId,
    agentIds: [...new Set(agents.map((a) => a.agentId))],
  };
}

const RULE_NOUN: Record<Rule, string> = {
  orders_drop: "Orders",
  denied_spike: "Payment denials",
  cancel_spike: "Cancellations",
};

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM of a 15-minute bucket of the local day. */
export const bucketTime = (bucket: number) => {
  const b = (bucket + BUCKETS_PER_DAY) % BUCKETS_PER_DAY;
  return `${pad(Math.floor((b * 15) / 60))}:${pad((b * 15) % 60)}`;
};
const round = (n: number) => Math.round(n).toLocaleString("en-US");

export function incidentTitle(
  rule: Rule,
  store: string,
  v: OrderMonitorVerdict,
): string {
  const since = bucketTime(v.from);
  if (rule === "orders_drop") {
    const below =
      v.expected > 0 ? Math.round((1 - v.observed / v.expected) * 100) : 100;
    return `Orders at ${store} are ${below} % below expected since ${since}`;
  }
  return `${RULE_NOUN[rule]} at ${store}: ${round(v.observed)} in an hour vs ${round(v.expected)} expected, since ${since}`;
}

function numbers(rule: Rule, v: OrderMonitorVerdict): string {
  const thresholds =
    rule === "orders_drop"
      ? `warning below ${round(v.warnAt)}, alert below ${round(v.alertAt)}`
      : `warning from ${round(v.warnAt)}, alert from ${round(v.alertAt)}`;
  return `${RULE_NOUN[rule]}: **${round(v.observed)}** between ${bucketTime(v.from)} and ${bucketTime(v.to)} vs **${round(v.expected)}** expected (${thresholds}).`;
}

const PRIORITY = { warning: "high", alert: "urgent" } as const;

/** Orders VTEX itself has in the verdict's window, or null when it can't say. */
async function vtexOrderCount(
  ctx: StudioContext,
  organizationId: string,
  vtexConnectionId: string,
  since: Date,
  until: Date,
): Promise<number | null> {
  const vtex = await ctx.storage.connections.findById(
    vtexConnectionId,
    organizationId,
  );
  if (!vtex) return null;
  const client = await clientFromConnection(vtex, ctx, true);
  try {
    const result = (await client.callTool({
      name: "VTEX_LIST_ORDERS",
      arguments: {
        f_creationDate: `creationDate:[${since.toISOString()} TO ${new Date(until.getTime() - 1).toISOString()}]`,
        per_page: 1,
      },
    })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: { type?: string; text?: string }[];
    };
    if (result.isError) return null;
    const body =
      result.structuredContent ??
      JSON.parse(result.content?.find((c) => c.type === "text")?.text ?? "{}");
    const parsed = z
      .object({ paging: z.object({ total: z.number() }) })
      .safeParse(body);
    return parsed.success ? parsed.data.paging.total : null;
  } finally {
    await client.close().catch(() => {});
  }
}

export interface IncidentInput {
  organizationId: string;
  connectionId: string;
  rule: Rule;
  action: Exclude<IncidentAction, "none">;
  verdict: OrderMonitorVerdict;
  at: Date;
  /** Since when the rule has held `verdict.status`. */
  since: Date;
}

/** Card + notification for one incident transition. Returns the card now linked to the rule. */
export async function syncIncidentTask(
  ctx: StudioContext,
  db: Kysely<Database>,
  storage: OrderMonitorStorage,
  input: IncidentInput,
): Promise<string | null> {
  const { organizationId, connectionId, rule, verdict, at, since } = input;
  const orgSlug = ctx.organization?.slug;
  if (!orgSlug) throw new Error("order incident needs the org's slug");
  // Read now, not at evaluation: a replayed or overlapping step may have linked a card since.
  const linked =
    (await storage.listStates(organizationId, connectionId)).find(
      (s) => s.rule === rule,
    )?.task?.id ?? null;
  if (input.action === "open" && linked) return linked;
  const store = await loadStoreInfo(ctx, storage, organizationId, connectionId);
  if (!store) return linked;

  const windowStart = localBucketStart(at, verdict.timezone, verdict.from);
  const windowEnd = localBucketStart(at, verdict.timezone, verdict.to);
  const chartAt = windowStart.toISOString();
  const localTime = (t: Date) =>
    t.toLocaleTimeString("en-GB", {
      timeZone: verdict.timezone,
      hour: "2-digit",
      minute: "2-digit",
    });
  let unconfirmed = false;

  // From the lake alone "the store sold nothing" and "our ingest stopped" look
  // the same. VTEX settles it before a customer is told their sales stopped.
  if (
    input.action === "open" &&
    rule === "orders_drop" &&
    store.vtexConnectionId
  ) {
    const vtexCount = await vtexOrderCount(
      ctx,
      organizationId,
      store.vtexConnectionId,
      windowStart,
      windowEnd,
    ).catch((err) => {
      console.warn(
        `[order-monitor] VTEX cross-check failed for connection ${connectionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    // VTEX above the warning line is a VTEX that isn't in this incident.
    if (vtexCount !== null && vtexCount >= verdict.warnAt) {
      console.error("[order-monitor] ingest incident", {
        organizationId,
        connectionId,
        lake: verdict.observed,
        vtex: vtexCount,
        since: windowStart.toISOString(),
      });
      await storage.setVerdictFlags(organizationId, connectionId, rule, {
        ingestIncident: true,
        crossCheckPending: false,
      });
      return null;
    }
    // VTEX didn't answer: ask again next tick rather than tell the customer
    // something only our ingest may have, until the wait runs out.
    if (vtexCount === null) {
      // From the first wait, not the status: warning ↔ alert must not restart it.
      const waitingSince = verdict.crossCheckSince
        ? new Date(verdict.crossCheckSince)
        : at;
      if (at.getTime() - waitingSince.getTime() < CROSS_CHECK_GRACE_MS) {
        await storage.setVerdictFlags(organizationId, connectionId, rule, {
          crossCheckPending: true,
          crossCheckSince: waitingSince.toISOString(),
        });
        return null;
      }
      unconfirmed = true;
    }
  }

  const taskBoard = ctx.storage.taskBoard;
  const card = linked ? await taskBoard.getById(linked, organizationId) : null;
  const live =
    card && card.status !== LANES.done && card.status !== LANES.archive;
  const notice: OrderIncidentNotice = {
    connectionId,
    store: store.title,
    rule,
    status: verdict.status,
    observed: verdict.observed,
    expected: verdict.expected,
    since: windowStart.toISOString(),
    timezone: verdict.timezone,
    at: chartAt,
  };
  const admins = await storage.listOrgAdmins(organizationId);
  const notifyAdmins = (taskBoardItemId: string) =>
    notify({
      db,
      taskBoardItemId,
      type: "order_incident",
      actorId: null,
      alsoSubscribe: admins,
      incident: notice,
    });

  if (input.action === "open") {
    const repoIds = store.agentIds[0]
      ? await storage.listAgentRepositoryIds(organizationId, store.agentIds[0])
      : [];
    const pushes = await listPushes(
      ctx,
      organizationId,
      repoIds,
      at,
      verdict.timezone,
      {
        since: new Date(windowStart.getTime() - 2 * 60 * 60_000),
        until: windowStart,
      },
    );
    const pushLines = pushes.repos.flatMap((repo) =>
      repo.markers.flatMap((m) =>
        m.commits.map(
          (c) =>
            `- \`${c.sha.slice(0, 7)}\` ${c.message} — ${c.author} (${repo.name}, ${bucketTime(m.bucket)})`,
        ),
      ),
    );
    const description = [
      `${numbers(rule, verdict)}`,
      ...(unconfirmed
        ? [
            "VTEX couldn't be reached to confirm these numbers against the store's own order list.",
          ]
        : []),
      `[Open the Orders chart at the incident's start](${getBaseUrl()}${orderMonitorChartPath(orgSlug, connectionId, chartAt)})`,
      `**Pushes to main in the 2 hours before**\n${pushLines.length > 0 ? pushLines.join("\n") : "None."}`,
    ].join("\n\n");
    const created = await taskBoard.create({
      organizationId,
      title: incidentTitle(rule, store.title, verdict),
      description,
      status: LANES.intake,
      priority: PRIORITY[verdict.status as "warning" | "alert"],
      type: "bug",
      virtualMcpId: store.agentIds[0] ?? null,
      by: SUPER_AGENT_ASSIGNEE_ID,
    });
    await taskBoard.recordActivity({
      taskBoardItemId: created.id,
      action: "created",
      actorId: null,
    });
    await storage.setIncidentTask(
      organizationId,
      connectionId,
      rule,
      created.id,
    );
    await storage.setVerdictFlags(organizationId, connectionId, rule, {
      crossCheckPending: false,
    });
    await notifyAdmins(created.id);
    emitTaskBoardUpdated(organizationId, created);
    return created.id;
  }

  if (!card || !live) {
    // A person closed or archived it; the incident goes on without a card.
    if (linked) {
      await storage.setIncidentTask(organizationId, connectionId, rule, null);
    }
    return null;
  }

  // Too few orders to judge: noted on the card for whoever reads it, nobody is told.
  if (input.action === "pause") {
    await taskBoard.createComment({
      taskBoardItemId: card.id,
      organizationId,
      authorId: SUPER_AGENT_ASSIGNEE_ID,
      body: `Too few orders to judge since ${localTime(since)}. The card closes once the rule is back to normal for ${RECOVERY_MS / 60_000} minutes.`,
    });
    return card.id;
  }

  const recovered = input.action === "close";
  // Back into warning, or alert again on an urgent card, is the same incident: no news.
  if (
    !recovered &&
    !(verdict.status === "alert" && card.priority !== "urgent")
  ) {
    return card.id;
  }
  await taskBoard.createComment({
    taskBoardItemId: card.id,
    organizationId,
    authorId: SUPER_AGENT_ASSIGNEE_ID,
    body: recovered
      ? `Back to normal since ${localTime(since)}. ${numbers(rule, verdict)}`
      : `Now **alert**. ${numbers(rule, verdict)}`,
  });
  const updated = await taskBoard.update(
    card.id,
    organizationId,
    recovered ? { status: LANES.done } : { priority: PRIORITY.alert },
    SUPER_AGENT_ASSIGNEE_ID,
  );
  if (recovered) {
    await storage.setIncidentTask(organizationId, connectionId, rule, null);
  }
  await notifyAdmins(card.id);
  emitTaskBoardUpdated(organizationId, updated);
  return recovered ? null : card.id;
}
