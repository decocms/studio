import { describe, expect, test } from "bun:test";
import {
  parseFrontmatter,
  parseSkillMd,
  parseAgentMd,
  serializeAgentToMd,
  skillToRegistryItem,
  agentToRegistryItem,
} from "./skill-parser";

describe("parseFrontmatter", () => {
  test("parses basic key-value pairs", () => {
    const content = `---
name: my-skill
description: A test skill
---

Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("my-skill");
    expect(result.frontmatter.description).toBe("A test skill");
    expect(result.body).toBe("Body content here.");
  });

  test("parses YAML lists", () => {
    const content = `---
name: my-agent
skills:
  - skill-one
  - skill-two
  - skill-three
---

Agent body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter.skills).toEqual([
      "skill-one",
      "skill-two",
      "skill-three",
    ]);
  });

  test("handles missing frontmatter", () => {
    const content = "Just plain markdown content.";
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just plain markdown content.");
  });

  test("handles boolean values", () => {
    const content = `---
disable-model-invocation: true
enabled: false
---`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter["disable-model-invocation"]).toBe(true);
    expect(result.frontmatter.enabled).toBe(false);
  });
});

describe("parseSkillMd", () => {
  test("parses a standard SKILL.md", () => {
    const content = `---
name: review-pr
description: Analyze code changes with parallel critic subagents
disable-model-invocation: true
---

## Instructions

When the user asks to review a PR...`;

    const result = parseSkillMd(content);
    expect(result.name).toBe("review-pr");
    expect(result.description).toBe(
      "Analyze code changes with parallel critic subagents",
    );
    expect(result.disableModelInvocation).toBe(true);
    expect(result.body).toContain("When the user asks to review a PR");
  });
});

describe("parseAgentMd", () => {
  test("parses agent with skills list", () => {
    const content = `---
name: code-reviewer
description: Reviews PRs from multiple perspectives
icon: https://example.com/icon.png
skills:
  - review-pr
  - commit
instructions: |
  You are a code reviewer agent.
  Review PRs thoroughly.
---

# Code Reviewer

This agent reviews pull requests.`;

    const result = parseAgentMd(content);
    expect(result.name).toBe("code-reviewer");
    expect(result.description).toBe("Reviews PRs from multiple perspectives");
    expect(result.icon).toBe("https://example.com/icon.png");
    expect(result.skills).toEqual(["review-pr", "commit"]);
    expect(result.instructions).toContain("You are a code reviewer agent.");
    expect(result.body).toContain("This agent reviews pull requests.");
  });
});

describe("serializeAgentToMd", () => {
  test("roundtrips agent data", () => {
    const agent = {
      title: "code-reviewer",
      description: "Reviews PRs",
      icon: "https://example.com/icon.png",
      metadata: {
        instructions: "You are a code reviewer.\nBe thorough.",
      },
      skillNames: ["review-pr", "commit"],
    };

    const md = serializeAgentToMd(agent);
    const parsed = parseAgentMd(md);

    expect(parsed.name).toBe("code-reviewer");
    expect(parsed.description).toBe("Reviews PRs");
    expect(parsed.icon).toBe("https://example.com/icon.png");
    expect(parsed.skills).toEqual(["review-pr", "commit"]);
    expect(parsed.instructions).toContain("You are a code reviewer.");
  });
});

describe("registryItem mappers", () => {
  test("skillToRegistryItem creates valid item", () => {
    const skill = parseSkillMd(`---
name: my-skill
description: A cool skill
---
Body.`);

    const item = skillToRegistryItem(skill, "decocms", "context", "my-skill");
    expect(item.id).toBe("decocms/context/skills/my-skill");
    expect(item.name).toBe("my-skill");
    expect(item.server.name).toBe("my-skill");
    expect(item._meta?.["mcp.mesh"]?.categories).toContain("Skills");
  });

  test("agentToRegistryItem creates valid item", () => {
    const agent = parseAgentMd(`---
name: reviewer
description: Reviews code
skills:
  - review-pr
---`);

    const item = agentToRegistryItem(agent, "decocms", "context", "reviewer");
    expect(item.id).toBe("decocms/context/agents/reviewer");
    expect(item.name).toBe("reviewer");
    expect(item._meta?.["mcp.mesh"]?.categories).toContain("Agents");
  });
});
