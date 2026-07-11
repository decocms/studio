import { describe, expect, test } from "bun:test";
import { toolCatalogFiles } from "./tools-catalog";

describe("toolCatalogFiles", () => {
  test("emits one JSON file per tool with name, description and schemas", () => {
    const files = toolCatalogFiles([
      {
        name: "SEND_EMAIL",
        description: "Send an email",
        inputSchema: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("SEND_EMAIL.json");
    const parsed = JSON.parse(files[0].content);
    expect(parsed.name).toBe("SEND_EMAIL");
    expect(parsed.description).toBe("Send an email");
    expect(parsed.inputSchema.properties.to.type).toBe("string");
    expect(parsed.outputSchema.properties.id.type).toBe("string");
  });

  test("omits description/outputSchema when absent and defaults inputSchema", () => {
    const files = toolCatalogFiles([{ name: "PING", inputSchema: undefined }]);
    const parsed = JSON.parse(files[0].content);
    expect("description" in parsed).toBe(false);
    expect("outputSchema" in parsed).toBe(false);
    expect(parsed.inputSchema).toEqual({ type: "object" });
  });

  test("sanitizes unsafe filename chars but keeps the real name inside", () => {
    const files = toolCatalogFiles([
      { name: "conn/../SEND", inputSchema: { type: "object" } },
    ]);
    // Slashes (the traversal risk) become underscores; dots are safe in a
    // bare filename and kept. safePath clamps the write regardless.
    expect(files[0].filename).toBe("conn_.._SEND.json");
    expect(files[0].filename).not.toContain("/");
    expect(JSON.parse(files[0].content).name).toBe("conn/../SEND");
  });
});
