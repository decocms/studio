/**
 * WhatsApp Concierge Ingest
 *
 * Global (NOT org-scoped) endpoint the deployed WhatsApp worker calls for every
 * inbound message. Routing is by the sender's verified phone, so the org is
 * resolved here — not from the URL.
 *
 *   POST /api/whatsapp/ingest   (Authorization: Bearer WHATSAPP_INGEST_SECRET)
 *   { phone, text, messageId?, name? }  ->  202 (processed async)
 *
 * Flow: verify pending code (inbound verification) → resolve phone→user →
 * resolve target org (selected / single / in-chat pick-list) → run the agent as
 * the real user → deliver the reply via the worker's /send.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import { getBaseUrl } from "@/core/server-constants";
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

    // ACK now; process out of band (agent runs can take a while).
    void handleInbound({ db: deps.db, userPhones, phone, text, name }).catch(
      (err) =>
        console.error(
          "[whatsapp-ingest] processing failed:",
          err instanceof Error ? err.message : err,
        ),
    );

    return c.json({ ok: true }, 202);
  });

  return app;
}

async function handleInbound(args: {
  db: Kysely<Database>;
  userPhones: UserPhoneStorage;
  phone: string;
  text: string;
  name: string;
}): Promise<void> {
  const { db, userPhones, phone, text, name } = args;

  // 1) Verification: a Studio-issued code sent BY the user proves ownership.
  const codeCandidate = text.toUpperCase().replace(/\s+/g, "");
  const pending = codeCandidate
    ? await userPhones.findPendingByCode(codeCandidate)
    : null;
  if (pending) {
    const result = await userPhones.bindVerified(pending.userId, phone);
    await sendWhatsApp(
      phone,
      result.ok
        ? "✅ Your number is now linked to deco."
        : "This number is already linked to another deco account.",
    );
    return;
  }

  // 2) Resolve the sender to a verified user.
  const link = await userPhones.findVerifiedByPhone(phone);
  if (!link) {
    await sendWhatsApp(
      phone,
      `This number isn't linked to a deco account yet. Link it from your profile at ${getBaseUrl()}.`,
    );
    return;
  }

  // 3) Resolve the target organization.
  const orgs = await listEnabledOrgs(db, link.userId);
  const resolution = resolveTargetOrg({
    text,
    orgs,
    selectedOrgId: link.selectedOrganizationId,
  });

  let target: WhatsappEnabledOrg;
  switch (resolution.kind) {
    case "none":
      await sendWhatsApp(
        phone,
        "No organization has WhatsApp enabled for you yet.",
      );
      return;
    case "switch":
      await userPhones.setSelectedOrg(link.userId, null);
      await sendWhatsApp(phone, pickListText(orgs));
      return;
    case "pick":
      await sendWhatsApp(phone, pickListText(orgs));
      return;
    case "select":
      await userPhones.setSelectedOrg(link.userId, resolution.org.orgId);
      target = resolution.org;
      break;
    case "route":
      target = resolution.org;
      if (orgs.length === 1) {
        await userPhones.setSelectedOrg(link.userId, target.orgId);
      }
      break;
  }

  if (!target.agentId) {
    await sendWhatsApp(
      phone,
      `WhatsApp isn't fully set up for ${target.orgName} yet (no agent selected).`,
    );
    return;
  }

  // 4) Run the agent AS the real user, in a stable per-user+org thread.
  const { replyText } = await runChannelTurn({
    organizationId: target.orgId,
    userId: link.userId,
    agentId: target.agentId,
    threadId: threadIdFor(phone, target.orgId),
    userText: text,
    sender: { platform: "whatsapp", senderId: phone, senderName: name },
  });

  await sendWhatsApp(
    phone,
    replyText || "I wasn't able to produce a response. Please try again.",
  );
}
