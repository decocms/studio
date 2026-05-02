import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTestDatabase, createTestDatabase } from "../../database/test-db";
import { createTestSchema } from "../../storage/test-helpers";
import type { DetectedProject } from "./detect";
import { draftSystemPrompt } from "./prompt";

describe("draftSystemPrompt", () => {
  it("returns a template prompt when skipLlm is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "autostart-prompt-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ description: "demo project" }),
    );
    const project: DetectedProject = {
      root,
      name: "demo",
      packageManager: "bun",
      starter: "dev",
      description: "demo project",
      readmePreview: "# demo\n\nA cool MCP",
      promptFile: null,
    };

    const database = await createTestDatabase();
    try {
      await createTestSchema(database.db);
      const result = await draftSystemPrompt({
        db: database.db,
        organizationId: "org_x",
        project,
        tools: [
          { name: "send_email", description: "Send an email" },
          { name: "list_inbox", description: "List inbox messages" },
        ] as never,
        skipLlm: true,
      });
      expect(result.source).toBe("template");
      expect(result.prompt).toContain("demo");
      expect(result.prompt).toContain("send_email");
      expect(result.prompt).toContain("list_inbox");
    } finally {
      await closeTestDatabase(database);
    }
  });

  it("uses an authored prompt.md file when present", async () => {
    const root = mkdtempSync(join(tmpdir(), "autostart-prompt-"));
    const promptPath = join(root, "prompt.md");
    writeFileSync(promptPath, "# CEO Agent\n\nYou tend the company.");
    const project: DetectedProject = {
      root,
      name: "ceo-agent",
      packageManager: "bun",
      starter: "dev",
      description: null,
      readmePreview: null,
      promptFile: promptPath,
    };

    const database = await createTestDatabase();
    try {
      await createTestSchema(database.db);
      const result = await draftSystemPrompt({
        db: database.db,
        organizationId: "org_x",
        project,
        tools: [],
        skipLlm: true, // confirms file path wins even when LLM is allowed
      });
      expect(result.source).toBe("file");
      expect(result.prompt).toContain("You tend the company");
    } finally {
      await closeTestDatabase(database);
    }
  });

  it("falls back to template when no provider key is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "autostart-prompt-"));
    const project: DetectedProject = {
      root,
      name: "noprovider",
      packageManager: "bun",
      starter: "dev",
      description: null,
      readmePreview: null,
      promptFile: null,
    };

    const database = await createTestDatabase();
    try {
      await createTestSchema(database.db);
      // No AI provider keys seeded → falls back to template (skipLlm: false)
      const result = await draftSystemPrompt({
        db: database.db,
        organizationId: "org_empty",
        project,
        tools: [],
      });
      expect(result.source).toBe("template");
      expect(result.prompt).toContain("noprovider");
    } finally {
      await closeTestDatabase(database);
    }
  });
});
