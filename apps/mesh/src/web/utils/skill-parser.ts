/**
 * Skill & Agent Markdown Parser + Serializer
 *
 * Parses SKILL.md and AGENT.md files with YAML frontmatter.
 * Also serializes agent definitions back to markdown for export.
 */

import type { RegistryItem } from "../components/store/types";

// ============================================================================
// Frontmatter parser
// ============================================================================

interface Frontmatter {
  [key: string]: string | string[] | boolean | undefined;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Handles simple key: value pairs and YAML lists (- item).
 */
export function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlBlock, body] = match;
  const frontmatter: Frontmatter = {};

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of (yamlBlock ?? "").split("\n")) {
    const trimmed = line.trim();

    // List item under current key
    if (trimmed.startsWith("- ") && currentKey && currentList) {
      currentList.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush any pending list
    if (currentKey && currentList) {
      frontmatter[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    // Key: value pair
    const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    if (!key) continue;
    const value = (rawValue ?? "").trim();

    // Multi-line scalar (key: |)
    if (value === "|" || value === ">") {
      // Collect subsequent indented lines as the value
      currentKey = key;
      // We'll handle this in a second pass — for now, mark as empty
      frontmatter[key] = "";
      continue;
    }

    // Empty value might start a list
    if (value === "") {
      currentKey = key;
      currentList = [];
      continue;
    }

    // Remove surrounding quotes
    const unquoted = value.replace(/^["']|["']$/g, "");

    // Boolean values
    if (unquoted === "true") {
      frontmatter[key] = true;
      continue;
    }
    if (unquoted === "false") {
      frontmatter[key] = false;
      continue;
    }

    frontmatter[key] = unquoted;
  }

  // Flush trailing list
  if (currentKey && currentList) {
    frontmatter[currentKey] = currentList;
  }

  // Second pass: handle multi-line scalars (| or >)
  const multilineRegex =
    /^(\w[\w-]*)\s*:\s*[|>]\s*\r?\n((?:[ \t]+[^\n]*\r?\n?)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = multilineRegex.exec(yamlBlock ?? "")) !== null) {
    const key = m[1]!;
    const block = m[2] ?? "";
    // Dedent: find minimum indentation
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const minIndent = Math.min(
      ...lines.map((l) => l.match(/^(\s*)/)?.[1]?.length ?? 0),
    );
    frontmatter[key] = lines.map((l) => l.slice(minIndent)).join("\n");
  }

  return { frontmatter, body: (body ?? "").trim() };
}

// ============================================================================
// Skill parser
// ============================================================================

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  disableModelInvocation?: boolean;
  metadata?: Record<string, unknown>;
}

export function parseSkillMd(content: string): ParsedSkill {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    name: String(frontmatter.name ?? ""),
    description: String(frontmatter.description ?? ""),
    body,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    metadata: frontmatter as Record<string, unknown>,
  };
}

// ============================================================================
// Agent parser
// ============================================================================

export interface ParsedAgent {
  name: string;
  description: string;
  icon?: string;
  skills: string[];
  instructions: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export function parseAgentMd(content: string): ParsedAgent {
  const { frontmatter, body } = parseFrontmatter(content);
  const skills = Array.isArray(frontmatter.skills)
    ? frontmatter.skills
    : typeof frontmatter.skills === "string"
      ? [frontmatter.skills]
      : [];

  return {
    name: String(frontmatter.name ?? ""),
    description: String(frontmatter.description ?? ""),
    icon: frontmatter.icon ? String(frontmatter.icon) : undefined,
    skills,
    instructions: String(frontmatter.instructions ?? ""),
    body,
    metadata: frontmatter as Record<string, unknown>,
  };
}

// ============================================================================
// Serializer (agent → markdown export)
// ============================================================================

export function serializeAgentToMd(agent: {
  title: string;
  description?: string | null;
  icon?: string | null;
  metadata?: { instructions?: string | null } | null;
  skillNames?: string[];
}): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${agent.title}`);
  if (agent.description) {
    lines.push(`description: ${agent.description}`);
  }
  if (agent.icon) {
    lines.push(`icon: ${agent.icon}`);
  }
  if (agent.skillNames && agent.skillNames.length > 0) {
    lines.push("skills:");
    for (const skill of agent.skillNames) {
      lines.push(`  - ${skill}`);
    }
  }
  if (agent.metadata?.instructions) {
    lines.push("instructions: |");
    for (const line of agent.metadata.instructions.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// ============================================================================
// RegistryItem mappers
// ============================================================================

export function skillToRegistryItem(
  skill: ParsedSkill,
  owner: string,
  repo: string,
  dirName: string,
): RegistryItem {
  return {
    id: `${owner}/${repo}/skills/${dirName}`,
    name: skill.name || dirName,
    title: skill.name || dirName,
    description: skill.description,
    server: {
      name: dirName,
      title: skill.name || dirName,
      description: skill.description,
      repository: {
        url: `https://github.com/${owner}/${repo}`,
        source: "github",
        subfolder: `skills/${dirName}`,
      },
    },
    _meta: {
      "mcp.mesh": {
        id: `${owner}/${repo}/skills/${dirName}`,
        tags: ["skill"],
        categories: ["Skills"],
      },
      "mesh.github": {
        type: "skill",
        owner,
        repo,
        path: `skills/${dirName}`,
      },
    } as RegistryItem["_meta"],
  };
}

export function agentToRegistryItem(
  agent: ParsedAgent,
  owner: string,
  repo: string,
  fileName: string,
): RegistryItem {
  return {
    id: `${owner}/${repo}/agents/${fileName}`,
    name: agent.name || fileName,
    title: agent.name || fileName,
    description: agent.description,
    icon: agent.icon,
    server: {
      name: fileName,
      title: agent.name || fileName,
      description: agent.description,
      repository: {
        url: `https://github.com/${owner}/${repo}`,
        source: "github",
        subfolder: `agents/${fileName}`,
      },
    },
    _meta: {
      "mcp.mesh": {
        id: `${owner}/${repo}/agents/${fileName}`,
        tags: ["agent", ...agent.skills],
        categories: ["Agents"],
      },
      "mesh.github": {
        type: "agent",
        owner,
        repo,
        path: `agents/${fileName}`,
        skills: agent.skills,
        instructions: agent.instructions,
      },
    } as RegistryItem["_meta"],
  };
}
