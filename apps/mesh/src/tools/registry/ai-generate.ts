import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { z } from "zod";
import {
  RegistryAIGenerateInputSchema,
  RegistryAIGenerateOutputSchema,
} from "./schema";

function normalizeList(values: string[]): string[] {
  return Array.from(
    new Set(
      values.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0),
    ),
  );
}

function extractTextOutput(result: {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  const structured = result.structuredContent as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;

  const fromStructured = structured?.content
    ?.filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();

  if (fromStructured) return fromStructured;

  return (
    result.content
      ?.filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

function buildPrompt(input: z.infer<typeof RegistryAIGenerateInputSchema>): {
  system: string;
  user: string;
  maxOutputTokens: number;
} {
  const ctx = input.context;
  const contextJson = JSON.stringify(
    {
      name: ctx.name ?? "",
      provider: ctx.provider ?? "",
      url: ctx.url ?? "",
      owner: ctx.owner ?? "",
      repositoryUrl: ctx.repositoryUrl ?? "",
      description: ctx.description ?? "",
      shortDescription: ctx.shortDescription ?? "",
      tags: ctx.tags ?? [],
      categories: ctx.categories ?? [],
      availableTags: ctx.availableTags ?? [],
      availableCategories: ctx.availableCategories ?? [],
      tools: ctx.tools ?? [],
    },
    null,
    2,
  );

  if (input.type === "description") {
    return {
      system:
        "You are an assistant that writes concise MCP registry descriptions.",
      user: `Use the context below to write a clear English description for this MCP server.
Rules:
- Maximum 1500 characters
- Explain what the MCP does and typical use cases
- No markdown list, plain text only

Context:
${contextJson}`,
      maxOutputTokens: 600,
    };
  }

  if (input.type === "short_description") {
    return {
      system: "You write short summaries for MCP catalog cards.",
      user: `Use the context below and write ONE short description in English.
Rules:
- Maximum 160 characters
- Plain text only
- Return only the short description

Context:
${contextJson}`,
      maxOutputTokens: 120,
    };
  }

  if (input.type === "tags") {
    return {
      system: "You suggest tags for MCP catalog entries.",
      user: `Use the context below and suggest 3 to 5 tags in English, lowercase.
Rules:
- Return only a comma-separated list
- Prefer existing tags when relevant
- Avoid duplicates
Available tags: ${(ctx.availableTags ?? []).join(", ")}

Context:
${contextJson}`,
      maxOutputTokens: 120,
    };
  }

  if (input.type === "categories") {
    return {
      system: "You suggest the best category for MCP catalog entries.",
      user: `Use the context below and return the best category in English.
Rules:
- Prefer one of the available categories when possible
- Return only one category in lowercase
Available categories: ${(ctx.availableCategories ?? []).join(", ")}

Context:
${contextJson}`,
      maxOutputTokens: 80,
    };
  }

  return {
    system: "You are a technical writer for MCP server documentation.",
    user: `Write a README in markdown for this MCP server in English.
Rules:
- Include: title, overview, setup, authentication (if relevant), usage, tools, examples
- Maximum 50000 characters
- Return markdown only

Context:
${contextJson}`,
    maxOutputTokens: 4000,
  };
}

export const REGISTRY_AI_GENERATE = defineTool({
  name: "REGISTRY_AI_GENERATE" as const,
  description:
    "Generate MCP metadata (description, short description, tags, categories, README) using an LLM.",
  inputSchema: RegistryAIGenerateInputSchema,
  outputSchema: RegistryAIGenerateOutputSchema,

  handler: async (input, ctx) => {
    requireOrganization(ctx);
    await ctx.access.check();
    const { system, user, maxOutputTokens } = buildPrompt(input);
    const proxy = await ctx.createMCPProxy(input.llmConnectionId);

    try {
      const llmResult = await proxy.callTool({
        name: "LLM_DO_GENERATE",
        arguments: {
          modelId: input.modelId,
          callOptions: {
            temperature: 0.2,
            maxOutputTokens,
            prompt: [
              { role: "system", content: system },
              { role: "user", content: [{ type: "text", text: user }] },
            ],
          },
        },
      });

      if (llmResult.isError) {
        const content = llmResult.content as
          | Array<{ type?: string; text?: string }>
          | undefined;
        const message =
          content?.find((p) => p.type === "text")?.text ??
          "Failed to generate content";
        throw new Error(message);
      }

      const rawText = extractTextOutput(
        llmResult as {
          structuredContent?: unknown;
          content?: Array<{ type?: string; text?: string }>;
        },
      );

      if (input.type === "tags" || input.type === "categories") {
        const items = normalizeList(
          rawText.split(/[,\n;]/).map((v) => v.replace(/^[-*]\s*/, "")),
        );
        return { items: items.slice(0, input.type === "tags" ? 5 : 1) };
      }

      if (input.type === "description")
        return { result: rawText.slice(0, 1500) };
      if (input.type === "short_description")
        return { result: rawText.slice(0, 160) };
      if (input.type === "readme") return { result: rawText.slice(0, 50000) };

      return { result: rawText };
    } finally {
      await proxy.close?.().catch(() => {});
    }
  },
});
