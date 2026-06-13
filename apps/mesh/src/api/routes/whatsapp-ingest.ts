/**
 * WhatsApp Concierge Ingest
 *
 * Global (NOT org-scoped) endpoint the decocms concierge worker calls for every
 * inbound WhatsApp message. Routing is by the sender's verified phone, so the
 * org is resolved here — not from the URL.
 *
 *   POST /api/whatsapp/ingest   (Authorization: Bearer WHATSAPP_INGEST_SECRET)
 *   { phone, text, messageId?, name? }  ->  { handled: boolean }
 *
 * `handled: false` means this message is NOT Studio's (unknown phone, or a
 * verified user with no WhatsApp-enabled org) — the concierge should fall back
 * to its own bot. `handled: true` means Studio owns it (a verification code, or
 * a linked user with an enabled org); the classification is synchronous, and the
 * reply is delivered asynchronously via the worker's send endpoint.
 *
 * Flow: verify pending code (inbound verification) → resolve phone→user →
 * resolve target org (selected / single / in-chat pick-list) → run the agent as
 * the real user → deliver the reply via the worker's send endpoint.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import { canonicalizePhone } from "@/channels/phone";
import { runChannelTurn } from "@/channels/run-channel-turn";
import { sendWhatsApp } from "@/channels/whatsapp-worker";
import { getSettings } from "@/settings";
import { UserPhoneStorage } from "@/storage/user-phones";
import type { Database } from "@/storage/types";

const MAX_BODY_SIZE = 262_144; // 256KB

export interface WhatsappEnabledOrg {
  orgId: string;
  orgName: string;
  agentId: string | null;
}

export type OrgResolution =
  | { kind: "none" }
  | { kind: "switch" }
  | { kind: "pick" }
  | { kind: "route"; org: WhatsappEnabledOrg }
  | { kind: "select"; org: WhatsappEnabledOrg };

const SWITCH_COMMANDS = new Set(["switch", "/switch", "orgs", "/orgs"]);

/**
 * Pure resolver for which org should answer. Exported for unit testing.
 * `orgs` must be sorted deterministically (e.g. by channel created_at).
 */
export function resolveTargetOrg(args: {
  text: string;
  orgs: WhatsappEnabledOrg[];
  selectedOrgId: string | null;
}): OrgResolution {
  const { text, orgs, selectedOrgId } = args;
  if (orgs.length === 0) return { kind: "none" };
  if (SWITCH_COMMANDS.has(text.trim().toLowerCase())) return { kind: "switch" };
  if (orgs.length === 1) return { kind: "route", org: orgs[0]! };

  const selected = selectedOrgId
    ? orgs.find((o) => o.orgId === selectedOrgId)
    : undefined;
  if (selected) return { kind: "route", org: selected };

  // No active selection + multiple orgs: a bare number picks from the list.
  const n = Number(text.trim());
  const picked = Number.isInteger(n) ? orgs[n - 1] : undefined;
  if (picked) return { kind: "select", org: picked };
  return { kind: "pick" };
}

function pickListText(orgs: WhatsappEnabledOrg[]): string {
  const lines = orgs.map((o, i) => `${i + 1}. ${o.orgName}`);
  return [
    "You're in more than one organization on WhatsApp. Reply with a number to choose which one I should talk to:",
    ...lines,
    "(send 'switch' anytime to change)",
  ].join("\n");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function threadIdFor(phone: string, orgId: string): string {
  const hash = createHash("sha1")
    .update(`${phone}:${orgId}`)
    .digest("hex")
    .slice(0, 24);
  return `thrd_wa_${hash}`;
}

async function listEnabledOrgs(
  db: Kysely<Database>,
  userId: string,
): Promise<WhatsappEnabledOrg[]> {
  const rows = await db
    .selectFrom("channels")
    .innerJoin("organization", "organization.id", "channels.organization_id")
    .innerJoin("member", "member.organizationId", "channels.organization_id")
    .where("member.userId", "=", userId)
    .where("channels.channel_type", "=", "whatsapp")
    .where("channels.status", "=", "active")
    .select([
      "organization.id as orgId",
      "organization.name as orgName",
      "channels.agent_id as agentId",
    ])
    .orderBy("channels.created_at", "asc")
    .execute();
  return rows.map((r) => ({
    orgId: r.orgId,
    orgName: r.orgName,
    agentId: r.agentId,
  }));
}

export function createWhatsappIngestRoutes(deps: { db: Kysely<Database> }) {
  const app = new Hono();
  const userPhones = new UserPhoneStorage(deps.db);

  const limit = bodyLimit({
    maxSize: MAX_BODY_SIZE,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  });

  app.post("/ingest", limit, async (c) => {
    const secret = getSettings().whatsappIngestSecret;
    if (!secret) return c.json({ error: "WhatsApp not configured" }, 503);

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!constantTimeEqual(token, secret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: { phone?: string; text?: string; name?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const phone = canonicalizePhone(body.phone);
    const text = (body.text ?? "").trim();
    const name = body.name?.trim() || phone;
    if (!phone) return c.json({ error: "phone required" }, 400);

    // Classify synchronously (fast DB lookups) so we can tell the caller whether
    // Studio OWNS this message. `handled: false` ⇒ the concierge runs its own
    // bot (presales, etc.). The reply itself is delivered async via the worker's
    // send endpoint, so we don't block on the agent loop here.
    const decision = await classify({
      db: deps.db,
      userPhones,
      phone,
      text,
    });

    if (!decision.handled) return c.json({ handled: false }, 200);

    void dispatch(decision, { db: deps.db, userPhones, phone, name }).catch(
      (err) =>
        console.error(
          "[whatsapp-ingest] dispatch failed:",
          err instanceof Error ? err.message : err,
        ),
    );
    return c.json({ handled: true }, 200);
  });

  return app;
}

type Decision =
  | { handled: false }
  | { handled: true; kind: "verify"; userId: string }
  | {
      handled: true;
      kind: "pick";
      userId: string;
      orgs: WhatsappEnabledOrg[];
    }
  | {
      handled: true;
      kind: "route";
      userId: string;
      target: WhatsappEnabledOrg;
      persistSelection: boolean;
      text: string;
    };

/**
 * Decide whether Studio owns this inbound. Studio handles only:
 *  - a Studio-issued verification code (the user proving phone ownership), or
 *  - a message from a phone linked to a user who has ≥1 WhatsApp-enabled org.
 * Everything else returns `handled: false` so the concierge runs its own bot.
 */
async function classify(args: {
  db: Kysely<Database>;
  userPhones: UserPhoneStorage;
  phone: string;
  text: string;
}): Promise<Decision> {
  const { db, userPhones, phone, text } = args;

  const codeCandidate = text.toUpperCase().replace(/\s+/g, "");
  if (codeCandidate) {
    const pending = await userPhones.findPendingByCode(codeCandidate);
    if (pending)
      return { handled: true, kind: "verify", userId: pending.userId };
  }

  const link = await userPhones.findVerifiedByPhone(phone);
  if (!link) return { handled: false };

  const orgs = await listEnabledOrgs(db, link.userId);
  const resolution = resolveTargetOrg({
    text,
    orgs,
    selectedOrgId: link.selectedOrganizationId,
  });

  switch (resolution.kind) {
    case "none":
      return { handled: false };
    case "switch":
    case "pick":
      return { handled: true, kind: "pick", userId: link.userId, orgs };
    case "select":
      return {
        handled: true,
        kind: "route",
        userId: link.userId,
        target: resolution.org,
        persistSelection: true,
        text,
      };
    case "route":
      return {
        handled: true,
        kind: "route",
        userId: link.userId,
        target: resolution.org,
        persistSelection: orgs.length === 1,
        text,
      };
  }
}

/** Perform the side effects + reply for a handled message (async). */
async function dispatch(
  decision: Exclude<Decision, { handled: false }>,
  deps: {
    db: Kysely<Database>;
    userPhones: UserPhoneStorage;
    phone: string;
    name: string;
  },
): Promise<void> {
  const { userPhones, phone, name } = deps;

  if (decision.kind === "verify") {
    const result = await userPhones.bindVerified(decision.userId, phone);
    await sendWhatsApp(
      phone,
      result.ok
        ? "✅ Your number is now linked to deco."
        : "This number is already linked to another deco account.",
    );
    return;
  }

  if (decision.kind === "pick") {
    // `switch` resolves to "pick" too — clear any stale selection first.
    await userPhones.setSelectedOrg(decision.userId, null);
    await sendWhatsApp(phone, pickListText(decision.orgs));
    return;
  }

  // route
  if (decision.persistSelection) {
    await userPhones.setSelectedOrg(decision.userId, decision.target.orgId);
  }
  if (!decision.target.agentId) {
    await sendWhatsApp(
      phone,
      `WhatsApp isn't fully set up for ${decision.target.orgName} yet (no agent selected).`,
    );
    return;
  }

  const { replyText } = await runChannelTurn({
    organizationId: decision.target.orgId,
    userId: decision.userId,
    agentId: decision.target.agentId,
    threadId: threadIdFor(phone, decision.target.orgId),
    userText: decision.text,
    sender: { platform: "whatsapp", senderId: phone, senderName: name },
  });

  await sendWhatsApp(
    phone,
    replyText || "I wasn't able to produce a response. Please try again.",
  );
}
