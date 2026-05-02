/**
 * Drafts the system prompt for the auto-created agent.
 *
 * Strategy:
 *   1. If the org has at least one configured AI provider key, use a small
 *      LLM to draft a project-aware prompt from README + package.json + tool
 *      list.
 *   2. Otherwise (or on any failure), fall back to a deterministic template.
 *
 * Autostart never blocks on this — failures fall back silently.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { generateText } from "ai";
import { AIProviderFactory } from "../../ai-providers/factory";
import { CredentialVault } from "../../encryption/credential-vault";
import { getSettings } from "../../settings";
import { AIProviderKeyStorage } from "../../storage/ai-provider-keys";
import type { Database } from "../../storage/types";
import type { ToolDefinition } from "../../tools/connection/schema";
import type { DetectedProject } from "./detect";

const META_PROMPT = `You write system prompts for AI agents that operate against an MCP server.

Given a project's README, package.json description, source excerpts, and the
list of MCP tools the agent can call, write a concise system prompt (6–12 lines)
that:

- Names the agent's role in 1 line.
- States the project's purpose in 1–2 lines (do not paste the README).
- Lists 3–6 of the most useful tools by name with a one-line description each.
- Ends with a short instruction to prefer calling tools over answering from memory.

Output the system prompt directly — no preamble, no markdown fences, no explanation.`;

const SOURCE_PATHS_TO_TRY = [
  "api/app.ts",
  "api/main.bun.ts",
  "api/tools/index.ts",
];

const SOURCE_DIRS_TO_LIST = ["api/tools", "tools"];

const MAX_README = 8_000;
const MAX_SOURCE = 12_000;
const MAX_DEPS = 30;

function fallbackTemplate(
  project: DetectedProject,
  tools: { name: string; description?: string | null }[],
): string {
  const lines: string[] = [];
  lines.push(`You are the agent for "${project.name}".`);
  if (project.description) {
    lines.push(project.description);
  } else {
    const firstReadmeLine = project.readmePreview
      ?.split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (firstReadmeLine) lines.push(firstReadmeLine);
  }
  lines.push("");
  lines.push("Source: " + project.root);
  lines.push("");
  if (tools.length > 0) {
    lines.push("Tools available:");
    for (const t of tools.slice(0, 8)) {
      const desc = t.description?.split("\n")[0] ?? "";
      lines.push(`- ${t.name}${desc ? ": " + desc : ""}`);
    }
    lines.push("");
  }
  lines.push(
    "Prefer calling your tools over answering from memory. When a user asks",
  );
  lines.push(
    "you to do something this project supports, find the right tool first.",
  );
  return lines.join("\n");
}

function readFileSafe(path: string, max: number): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").slice(0, max);
  } catch {
    return null;
  }
}

function gatherSourceExcerpts(root: string): string {
  const chunks: string[] = [];
  let budget = MAX_SOURCE;
  for (const rel of SOURCE_PATHS_TO_TRY) {
    if (budget <= 0) break;
    const content = readFileSafe(join(root, rel), Math.min(budget, 4_000));
    if (content) {
      chunks.push(`--- ${rel} ---\n${content}`);
      budget -= content.length;
    }
  }
  for (const dir of SOURCE_DIRS_TO_LIST) {
    if (budget <= 0) break;
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    try {
      const entries = readdirSync(full)
        .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
        .slice(0, 6);
      for (const entry of entries) {
        if (budget <= 0) break;
        const content = readFileSafe(
          join(full, entry),
          Math.min(budget, 2_500),
        );
        if (content) {
          chunks.push(`--- ${dir}/${entry} ---\n${content}`);
          budget -= content.length;
        }
      }
    } catch {
      // ignore
    }
  }
  return chunks.join("\n\n");
}

function summarizePackageJson(root: string): string {
  const path = join(root, "package.json");
  if (!existsSync(path)) return "";
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      name?: string;
      description?: string;
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {}).slice(0, MAX_DEPS);
    const out: string[] = [];
    if (pkg.name) out.push(`name: ${pkg.name}`);
    if (pkg.description) out.push(`description: ${pkg.description}`);
    if (deps.length > 0) out.push(`dependencies: ${deps.join(", ")}`);
    return out.join("\n");
  } catch {
    return "";
  }
}

async function pickProviderKey(
  db: Kysely<Database>,
  organizationId: string,
): Promise<{ keyId: string; preferredModel: string | null } | null> {
  const vault = new CredentialVault(getSettings().encryptionKey);
  const storage = new AIProviderKeyStorage(db, vault);
  const keys = await storage.list({ organizationId });
  // Prefer Anthropic for prompt drafting (we know which models exist), else
  // first available.
  const anthropic = keys.find((k) => k.providerId === "anthropic");
  const chosen = anthropic ?? keys[0];
  if (!chosen) return null;

  const preferredModel =
    chosen.providerId === "anthropic" ? "claude-haiku-4-5" : null;

  return { keyId: chosen.id, preferredModel };
}

export interface DraftPromptParams {
  db: Kysely<Database>;
  organizationId: string;
  project: DetectedProject;
  tools: ToolDefinition[];
  /** When true, skip LLM and return the template (test/CI escape hatch). */
  skipLlm?: boolean;
}

export async function draftSystemPrompt(
  params: DraftPromptParams,
): Promise<{ prompt: string; source: "file" | "llm" | "template" }> {
  const { db, organizationId, project, tools, skipLlm } = params;

  const toolSummaries = tools.map((t) => ({
    name: t.name,
    description: t.description ?? null,
  }));

  // If the project ships its own agent prompt, that's authoritative.
  if (project.promptFile) {
    const authored = readFileSafe(project.promptFile, 64_000);
    if (authored && authored.trim().length > 0) {
      return { prompt: authored.trim(), source: "file" };
    }
  }

  if (skipLlm) {
    return {
      prompt: fallbackTemplate(project, toolSummaries),
      source: "template",
    };
  }

  try {
    const picked = await pickProviderKey(db, organizationId);
    if (!picked || !picked.preferredModel) {
      return {
        prompt: fallbackTemplate(project, toolSummaries),
        source: "template",
      };
    }

    const vault = new CredentialVault(getSettings().encryptionKey);
    const keyStorage = new AIProviderKeyStorage(db, vault);
    const factory = new AIProviderFactory(keyStorage);
    const provider = await factory.activate(picked.keyId, organizationId);
    const model = provider.aiSdk.languageModel(picked.preferredModel);

    const readme = project.readmePreview
      ? project.readmePreview.slice(0, MAX_README)
      : "";

    const userInput = [
      `Project name: ${project.name}`,
      `Path: ${project.root}`,
      "",
      "## package.json",
      summarizePackageJson(project.root) || "(no package.json)",
      "",
      "## README.md",
      readme || "(no README)",
      "",
      "## Source excerpts",
      gatherSourceExcerpts(project.root) || "(no source files matched)",
      "",
      "## MCP tools available",
      toolSummaries.length > 0
        ? toolSummaries
            .map((t) => `- ${t.name}: ${t.description?.split("\n")[0] ?? ""}`)
            .join("\n")
        : "(no tools fetched)",
    ].join("\n");

    const result = await generateText({
      model,
      system: META_PROMPT,
      messages: [{ role: "user", content: userInput }],
      maxOutputTokens: 600,
      temperature: 0.4,
      abortSignal: AbortSignal.timeout(20_000),
    });

    const text = result.text.trim();
    if (!text || text.length < 30) {
      return {
        prompt: fallbackTemplate(project, toolSummaries),
        source: "template",
      };
    }
    return { prompt: text, source: "llm" };
  } catch {
    return {
      prompt: fallbackTemplate(project, toolSummaries),
      source: "template",
    };
  }
}
