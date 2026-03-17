/**
 * SKILL_REGISTRY_GET Tool
 *
 * Gets a single skill or agent from a locally-cloned GitHub repository.
 * Returns full content including markdown body for the detail view.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { parseSkillMd, parseAgentMd } from "../../web/utils/skill-parser";
import { repoPath } from "./clone-repo";

const InputSchema = z.object({
  owner: z.string().describe("GitHub repository owner"),
  repo: z.string().describe("GitHub repository name"),
  type: z.enum(["skill", "agent"]).describe("Item type"),
  name: z.string().describe("Skill directory name or agent file name"),
});

const OutputSchema = z.object({
  type: z.enum(["skill", "agent"]),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  rawContent: z.string(),
  icon: z.string().optional(),
  skills: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  disableModelInvocation: z.boolean().optional(),
});

export const SKILL_REGISTRY_GET = defineTool({
  name: "SKILL_REGISTRY_GET",
  description:
    "Get a single skill or agent from a locally-cloned repository with full content for the detail view.",
  annotations: {
    title: "Get Registry Item",
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

    if (input.type === "skill") {
      const skillMd = join(localPath, "skills", input.name, "SKILL.md");
      if (!existsSync(skillMd)) {
        throw new Error(
          `Skill "${input.name}" not found in ${input.owner}/${input.repo}`,
        );
      }

      const rawContent = readFileSync(skillMd, "utf-8");
      const parsed = parseSkillMd(rawContent);

      return {
        type: "skill" as const,
        name: parsed.name || input.name,
        description: parsed.description,
        body: parsed.body,
        rawContent,
        disableModelInvocation: parsed.disableModelInvocation,
      };
    }

    // Agent
    const agentMd = join(localPath, "agents", `${input.name}.md`);
    if (!existsSync(agentMd)) {
      throw new Error(
        `Agent "${input.name}" not found in ${input.owner}/${input.repo}`,
      );
    }

    const rawContent = readFileSync(agentMd, "utf-8");
    const parsed = parseAgentMd(rawContent);

    return {
      type: "agent" as const,
      name: parsed.name || input.name,
      description: parsed.description,
      body: parsed.body,
      rawContent,
      icon: parsed.icon,
      skills: parsed.skills,
      instructions: parsed.instructions,
    };
  },
});
