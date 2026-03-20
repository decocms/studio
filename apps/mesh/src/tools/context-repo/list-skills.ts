import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { findContextRepo, getContextRepoPath } from "./helpers";

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: match[2]!.trim() };
}

export const CONTEXT_REPO_LIST_SKILLS = defineTool({
  name: "CONTEXT_REPO_LIST_SKILLS",
  description:
    "List available skills from the context repo's skills/ directory.",
  annotations: {
    title: "List Context Skills",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    skills: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        path: z.string(),
      }),
    ),
    repoFullName: z.string(),
  }),
  handler: async (_, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const config = await findContextRepo(ctx);
    if (!config)
      throw new Error(
        "No context repo configured. Use CONTEXT_REPO_SETUP first.",
      );

    const repoPath = getContextRepoPath(orgId, config.owner, config.repo);
    const skillsDir = join(repoPath, "skills");

    const skills: { name: string; description: string; path: string }[] = [];
    try {
      const entries = await readdir(skillsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        try {
          const content = await readFile(join(skillsDir, entry), "utf-8");
          const { frontmatter } = parseFrontmatter(content);
          skills.push({
            name: frontmatter.name || entry.replace(/\.md$/, ""),
            description: frontmatter.description || "",
            path: `skills/${entry}`,
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // skills/ directory doesn't exist — that's fine
    }

    return { skills, repoFullName: `${config.owner}/${config.repo}` };
  },
});
