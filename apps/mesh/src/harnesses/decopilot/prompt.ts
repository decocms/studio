/**
 * Decopilot system-prompt block helpers.
 *
 * The shared Decopilot core's ONE prompt assembler is
 * `buildAgentSystemPrompt` (`./build-agent-system-prompt`), invoked inside the
 * engine (`runAgentLoop`). It consumes the `list*Block` helpers below.
 * (The `<available-agents>` block is now pre-resolved agent-side as data and
 * rendered via `buildAgentsBlock`, so no storage-coupled helper lives here.)
 *
 * The previous standalone `assembleDecopilotPrompt` was a DUPLICATE assembler
 * whose output fed only the `_request.systemSections` debug metadata while the
 * real prompt was built by `buildAgentSystemPrompt`. The core now derives that
 * debug metadata from the engine's real assembled prompt
 * (`AssembledEngineHandle.assembledSystemMessages`), so the duplicate is gone.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildPromptsBlock,
  type PromptsBlockEntry,
} from "@decocms/harness/decopilot/prompts-block";
import {
  buildConnectionsBlock,
  type ConnectionsBlockTool,
} from "@decocms/harness/decopilot/connections-block";
import {
  buildSkillsBlock,
  parseSkillFrontmatter,
  type SkillEntry,
} from "@decocms/harness/decopilot/skills-block";
import {
  buildPublicOrgFs,
  getPublicSets,
  publicVolumeForSet,
} from "@/file-storage/public-sets";

/**
 * listPromptsBlock — fetches the MCP's prompt catalog via the passthrough
 * client and builds the `<available-prompts>` block. Returns null when no
 * client is provided (e.g., unit tests) or when the catalog is empty.
 */
export async function listPromptsBlock(
  _ctx: StudioContext,
  _org: OrganizationScope,
  passthroughClient?: Client,
): Promise<string | null> {
  if (!passthroughClient) return null;
  try {
    const { prompts } = await passthroughClient.listPrompts();
    if (!prompts?.length) return null;
    return buildPromptsBlock(
      prompts.map((p) => ({
        name: p.name,
        description: p.description ?? null,
        arguments: (p.arguments ?? []).map((a) => ({
          name: a.name,
          required: a.required,
        })),
      })) satisfies PromptsBlockEntry[],
    );
  } catch (err) {
    console.warn("[listPromptsBlock] Failed to list prompts:", err);
    return null;
  }
}

/**
 * listConnectionsBlock — builds the `<available-connections>` block from
 * pre-assembled tools data. Returns null when no data is provided or when
 * there are no tools to expose.
 */
export async function listConnectionsBlock(
  _ctx: StudioContext,
  _org: OrganizationScope,
  data?: {
    tools: ConnectionsBlockTool[];
    connectionTitleMap: Map<string, string>;
  },
): Promise<string | null> {
  if (!data || data.tools.length === 0) return null;
  return buildConnectionsBlock(data.tools, data.connectionTitleMap);
}

const decoder = new TextDecoder();
// Per-pod cache of parsed skills, keyed by `<volume>:<seq>`. Public skill sets
// are deployment-stable and only change on a sync (which bumps the volume's
// seq), so a hit avoids re-reading every SKILL.md from object storage on each
// message. ponytail: per-pod, unbounded-but-pruned-per-volume; move extraction
// into skill-set-sync if cross-pod or cold-start latency ever matters.
const skillsCache = new Map<string, SkillEntry[]>();

function skillDirName(entryPath: string): string {
  // "pdf/SKILL.md" → "pdf"; "a/b/SKILL.md" → "b"
  const segs = entryPath.split("/");
  return segs[segs.length - 2] ?? entryPath;
}

function firstProseLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith("#") && line !== "---") return line;
  }
  return "";
}

async function skillsForSet(
  ctx: StudioContext,
  set: string,
): Promise<SkillEntry[]> {
  const volume = publicVolumeForSet(set);
  const fs = buildPublicOrgFs(ctx);
  const seq = await fs.latestSeq(volume);
  const key = `${volume}:${seq}`;
  const cached = skillsCache.get(key);
  if (cached) return cached;

  const files = await fs.listFiles(volume);
  const skillMds = files.filter(
    (f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"),
  );
  const entries = await Promise.all(
    skillMds.map(async (f): Promise<SkillEntry> => {
      const text = decoder.decode(await fs.read(volume, f.path));
      const fm = parseSkillFrontmatter(text);
      return {
        name: `${set}/${fm.name ?? skillDirName(f.path)}`,
        description: fm.description ?? firstProseLine(text),
        path: `org/public/${set}/${f.path}`,
      };
    }),
  );
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const k of skillsCache.keys()) {
    if (k.startsWith(`${volume}:`)) skillsCache.delete(k);
  }
  skillsCache.set(key, entries);
  return entries;
}

/**
 * listSkillsBlock — builds the `<available-skills>` progressive-disclosure
 * index from the deployment's public skill sets (mounted at `org/public/<set>`).
 * Returns null when no skills exist. Never throws — a failure here must not
 * break the prompt, so it degrades to null.
 */
export async function listSkillsBlock(
  ctx: StudioContext,
): Promise<string | null> {
  try {
    const sets = await Promise.all(
      getPublicSets().map((s) => skillsForSet(ctx, s.set)),
    );
    return buildSkillsBlock(sets.flat());
  } catch (err) {
    console.warn("[listSkillsBlock] Failed to list skills:", err);
    return null;
  }
}
