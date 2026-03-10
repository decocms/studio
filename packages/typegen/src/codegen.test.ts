import { describe, test, expect } from "bun:test";
import { generateClientCode } from "./codegen.js";

describe("generateClientCode", () => {
  test("generates Tools interface with input and output types", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_abc123",
      tools: [
        {
          name: "SEARCH",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number" },
            },
            required: ["query"],
          },
          outputSchema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["results"],
          },
        },
      ],
    });

    // Must export Tools interface
    expect(output).toContain("export interface Tools");
    // Must have the tool key
    expect(output).toContain("SEARCH:");
    // Must have input/output subkeys
    expect(output).toContain("input:");
    expect(output).toContain("output:");
    // Must import createMeshClient
    expect(output).toContain('from "@decocms/typegen"');
    // Must call createMeshClient with the mcpId
    expect(output).toContain("vmc_abc123");
    expect(output).toContain("createMeshClient<Tools>");
  });

  test("uses unknown for missing outputSchema", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_test",
      tools: [
        {
          name: "NO_OUTPUT",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
    });

    expect(output).toContain("output: unknown");
  });

  test("handles multiple tools", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_multi",
      tools: [
        {
          name: "TOOL_A",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "TOOL_B",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    expect(output).toContain("TOOL_A:");
    expect(output).toContain("TOOL_B:");
  });

  test("inlines extra type aliases from nullable/described properties", async () => {
    // json-schema-to-typescript can emit helper `export type X = string | null`
    // declarations when properties have descriptions and nullable types.
    // These must not appear inside the Tools interface body.
    const output = await generateClientCode({
      mcpId: "vmc_test",
      tools: [
        {
          name: "GREP",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: ["string", "null"],
                description: "Query to search for",
              },
              include: {
                type: ["string", "null"],
                description: "Include pattern",
              },
            },
          },
        },
      ],
    });

    expect(output).not.toContain("export type Query");
    expect(output).not.toContain("export type Include");
    expect(output).toContain("GREP:");
  });

  test("exports a client const", async () => {
    const output = await generateClientCode({
      mcpId: "vmc_test",
      tools: [],
    });

    expect(output).toContain("export const client =");
  });
});
