/**
 * Agent kickstart prompts — persisted to a dedicated org-fs volume (one JSON
 * file per prompt) and served back as native MCP prompts on the agent's
 * gateway. Writing happens once at agent-create time; reading happens whenever
 * the gateway lists/gets prompts (icebreakers, org home, `/` mentions).
 *
 * The volume (`agent-prompts`) is intentionally NOT in the sandbox mount set,
 * so seeding an agent never pollutes the org's sandbox home.
 */

import { slugify } from "@decocms/mcp-utils/aggregate";
import type { AgentKickstartPrompt } from "@decocms/shared/sdk/types";
import type { OrgFs } from "./org-fs";

const AGENT_PROMPTS_VOLUME = "agent-prompts";

/** Backstop so a pathological agent can't make the gateway read forever. */
const MAX_PROMPTS = 20;

/** A stored prompt with the stable local name used to resolve it later. */
export interface StoredAgentPrompt {
  /** Local (un-namespaced) prompt name, unique within the agent. */
  name: string;
  title: string;
  description?: string;
  text: string;
}

function dir(agentId: string): string {
  return slugify(agentId);
}

/**
 * Width to zero-pad the index to, so filenames sort lexicographically
 * (as `listDir` returns them) in the same order the prompts were authored in
 * — e.g. `09-x` before `10-x`, not `10-x` before `2-x`.
 */
const INDEX_WIDTH = String(MAX_PROMPTS - 1).length;

/** Local name for the Nth prompt — stable, unique, and a valid file base. */
export function localName(index: number, title: string): string {
  const slug = slugify(title) || "prompt";
  return `${String(index).padStart(INDEX_WIDTH, "0")}-${slug}`;
}

/**
 * Delete every seeded prompt for an agent (the whole `agent-prompts/<agentId>/`
 * subtree). Best-effort: logs and swallows storage errors. Never throws.
 */
export async function deleteAgentPrompts(
  orgFs: OrgFs,
  agentId: string,
  actor: string,
): Promise<void> {
  try {
    await orgFs.delete(AGENT_PROMPTS_VOLUME, dir(agentId), { actor });
  } catch (err) {
    console.error("[agent-prompts] failed to delete prompts", { agentId, err });
  }
}

/**
 * (Re)seed an agent's kickstart prompts. Idempotent: clears the agent's
 * existing prompt dir first, then writes one JSON file per prompt under
 * `agent-prompts/<agentId>/`. So editing = pass the new full set, and passing
 * `[]` clears all. Best-effort per file: a failed write is logged and skipped
 * rather than failing the whole operation.
 */
export async function writeAgentPrompts(
  orgFs: OrgFs,
  agentId: string,
  actor: string,
  prompts: AgentKickstartPrompt[],
): Promise<void> {
  const base = dir(agentId);
  await deleteAgentPrompts(orgFs, agentId, actor);
  await Promise.all(
    prompts.slice(0, MAX_PROMPTS).map(async (p, i) => {
      const name = localName(i, p.title);
      const stored: StoredAgentPrompt = {
        name,
        title: p.title,
        description: p.description,
        text: p.text,
      };
      try {
        await orgFs.write(
          AGENT_PROMPTS_VOLUME,
          `${base}/${name}.json`,
          JSON.stringify(stored),
          { actor, contentType: "application/json" },
        );
      } catch (err) {
        console.error("[agent-prompts] failed to seed prompt", {
          agentId,
          name,
          err,
        });
      }
    }),
  );
}

/**
 * Read an agent's seeded prompts. Best-effort and bounded: returns [] on any
 * storage error and skips individual unreadable/corrupt files. Never throws.
 */
export async function readAgentPrompts(
  orgFs: OrgFs,
  agentId: string,
): Promise<StoredAgentPrompt[]> {
  const base = dir(agentId);
  let entries: Awaited<ReturnType<OrgFs["listDir"]>>;
  try {
    entries = await orgFs.listDir(AGENT_PROMPTS_VOLUME, base);
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.kind === "file" && e.path.endsWith(".json"))
    .slice(0, MAX_PROMPTS);

  const out: StoredAgentPrompt[] = [];
  for (const f of files) {
    try {
      const bytes = await orgFs.read(AGENT_PROMPTS_VOLUME, f.path);
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (
        parsed &&
        typeof parsed.name === "string" &&
        typeof parsed.title === "string" &&
        typeof parsed.text === "string"
      ) {
        out.push(parsed as StoredAgentPrompt);
      }
    } catch {
      // Corrupt/vanished file — skip it rather than break the whole list.
    }
  }
  return out;
}
