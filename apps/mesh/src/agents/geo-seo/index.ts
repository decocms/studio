/**
 * GEO Audit Agent — server-side installer.
 *
 * Mirrors the Studio Pack pattern (`apps/mesh/src/tools/virtual/studio-pack.ts`):
 * a stable per-org Virtual MCP whose `metadata.instructions` is the ported
 * `prompt.md`. The agent has no aggregated child connections — it relies
 * exclusively on Studio's built-in VM tools (bash/read/write/share_with_user)
 * to run the geo-seo-claude Python toolkit inside the warm sandbox.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VirtualMCPStorage } from "@/storage/virtual";

export const GEO_AUDIT_AGENT_ID_PREFIX = "geo-audit_";

export const getGeoAuditAgentId = (orgId: string): string =>
  `${GEO_AUDIT_AGENT_ID_PREFIX}${orgId}`;

export const isGeoAuditAgent = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(GEO_AUDIT_AGENT_ID_PREFIX);

export const GEO_AUDIT_AGENT = {
  title: "GEO Audit Agent",
  description:
    "Audit a website's visibility to AI search engines (ChatGPT, Claude, Perplexity, Google AI Overviews). Produces a composite GEO Score (0–100) and a prioritized action plan.",
  icon: "icon://BarChart02?color=violet",
} as const;

// Loaded once at module init. The prompt is bundled with the mesh server
// build, so readFileSync is fine here — no per-request I/O.
const PROMPT_PATH = fileURLToPath(new URL("./prompt.md", import.meta.url));
export const GEO_AUDIT_INSTRUCTIONS = readFileSync(PROMPT_PATH, "utf-8");

/**
 * Idempotently install the GEO Audit Agent for an organization. Skips if a
 * VIRTUAL connection with the canonical id already exists.
 */
export async function installGeoAuditAgent(
  orgId: string,
  createdBy: string,
  virtualMcpStorage: VirtualMCPStorage,
): Promise<void> {
  const id = getGeoAuditAgentId(orgId);
  const existing = await virtualMcpStorage.findById(id).catch(() => null);
  if (existing) return;

  await virtualMcpStorage.create(
    orgId,
    createdBy,
    {
      title: GEO_AUDIT_AGENT.title,
      description: GEO_AUDIT_AGENT.description,
      icon: GEO_AUDIT_AGENT.icon,
      status: "active",
      pinned: false,
      metadata: {
        instructions: GEO_AUDIT_INSTRUCTIONS,
      },
      connections: [],
    },
    { id },
  );
}
