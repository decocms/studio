/**
 * Seed sidebar personal agent membership for e2e.
 *
 * Since sidebar groups are explicit (org-pinned + personal localStorage order),
 * tests that create threads via API must add the agent to personal order before
 * expecting `[role=button][aria-expanded]` group headers.
 */

import type { Page } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "./db";

function sidebarPersonalOrderKey(orgId: string, userId: string): string {
  return `sidebar.group-order.${orgId}.${userId}`;
}

async function lookupOrgId(
  db: Client,
  orgSlug: string,
): Promise<string> {
  const orgRow = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [orgSlug],
  );
  const orgId = orgRow.rows[0]?.id;
  if (!orgId) {
    throw new Error(`organization not found for slug: ${orgSlug}`);
  }
  return orgId;
}

/** Runs before navigation so the first paint sees the seeded order. */
async function addSidebarPersonalAgentOrderInitScript(
  page: Page,
  options: { orgId: string; userId: string; agentIds: string[] },
): Promise<void> {
  const key = sidebarPersonalOrderKey(options.orgId, options.userId);
  await page.addInitScript(
    ({ storageKey, agentIds }) => {
      localStorage.setItem(storageKey, JSON.stringify(agentIds));
    },
    { storageKey: key, agentIds: options.agentIds },
  );
}

export async function addSidebarPersonalAgentOrderInitScriptForSlug(
  page: Page,
  orgSlug: string,
  userId: string,
  agentIds: string[],
): Promise<void> {
  const db = await connectDevDb();
  try {
    const orgId = await lookupOrgId(db, orgSlug);
    await addSidebarPersonalAgentOrderInitScript(page, {
      orgId,
      userId,
      agentIds,
    });
  } finally {
    await db.end();
  }
}
