/**
 * SKILL_REGISTRY_LIST Tool
 *
 * Lists skills and agents from a locally-cloned GitHub repository.
 * Reads skills/ and agents/ directories, parses SKILL.md and AGENT.md files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import {
  parseSkillMd,
  parseAgentMd,
  skillToRegistryItem,
  agentToRegistryItem,
} from "../../web/utils/skill-parser";
import { repoPath } from "./clone-repo";

const InputSchema = z.object({
  owner: z.string().describe("GitHub repository owner"),
  repo: z.string().describe("GitHub repository name"),
  type: z
    .enum(["all", "skills", "agents"])
    .optional()
    .default("all")
    .describe("Filter by item type"),
});

const OutputSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  total: z.number(),
});

export const SKILL_REGISTRY_LIST = defineTool({
  name: "SKILL_REGISTRY_LIST",
  description:
    "List skills and agents from a locally-cloned GitHub repository. Returns items compatible with the Store card grid.",
  annotations: {
    title: "List Registry Items",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const localPath = repoPath(input.owner, input.repo);
    if (!existsSync(localPath)) {
      throw new Error(
        `Repository ${input.owner}/${input.repo} not cloned. Call SKILL_REGISTRY_SYNC first.`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: Record<string, unknown>[] = [];

    // Read skills/
    if (input.type === "all" || input.type === "skills") {
      const skillsDir = join(localPath, "skills");
      if (existsSync(skillsDir)) {
        for (const entry of readdirSync(skillsDir)) {
          const entryPath = join(skillsDir, entry);
          if (!statSync(entryPath).isDirectory()) continue;

          const skillMd = join(entryPath, "SKILL.md");
          if (!existsSync(skillMd)) continue;

          const content = readFileSync(skillMd, "utf-8");
          const parsed = parseSkillMd(content);
          items.push(
            skillToRegistryItem(
              parsed,
              input.owner,
              input.repo,
              entry,
            ) as unknown as Record<string, unknown>,
          );
        }
      }
    }

    // Read agents/
    if (input.type === "all" || input.type === "agents") {
      const agentsDir = join(localPath, "agents");
      if (existsSync(agentsDir)) {
        for (const entry of readdirSync(agentsDir)) {
          if (!entry.endsWith(".md")) continue;
          const filePath = join(agentsDir, entry);
          if (!statSync(filePath).isFile()) continue;

          const content = readFileSync(filePath, "utf-8");
          const parsed = parseAgentMd(content);
          const name = entry.replace(/\.md$/, "");
          items.push(
            agentToRegistryItem(
              parsed,
              input.owner,
              input.repo,
              name,
            ) as unknown as Record<string, unknown>,
          );
        }
      }
    }

    return { items, total: items.length };
  },
});
