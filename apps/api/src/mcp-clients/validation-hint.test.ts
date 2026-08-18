import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  appendHintToResult,
  buildValidationHint,
  coerceArgsToSchema,
  enrichInvalidParams,
  invalidParamsResultText,
} from "./validation-hint";

describe("buildValidationHint", () => {
  const schema = {
    required: ["startDate", "endDate"],
    properties: { startDate: { type: "string" }, endDate: { type: "string" } },
  };

  it("names required params, what was sent, and what's missing", () => {
    const hint = buildValidationHint("query_search_analytics", schema, {
      endDate: "2026-07-01",
    });
    expect(hint).toBe(
      'Invalid arguments for "query_search_analytics". Required: startDate (string), endDate (string). You sent: endDate. Missing required: startDate.',
    );
  });

  it("reports (none) when no args were sent", () => {
    const hint = buildValidationHint("t", schema, undefined);
    expect(hint).toContain("You sent: (none).");
    expect(hint).toContain("Missing required: startDate, endDate.");
  });

  it("names arguments that are present but wrong-typed", () => {
    const hint = buildValidationHint(
      "POST_EDIT",
      { properties: { patch: { type: "object" }, save: { type: "boolean" } } },
      { patch: '{"sections":[]}', save: "true" },
    );
    expect(hint).toContain(
      "Wrong type: patch (expected object, got string), save (expected boolean, got string).",
    );
  });

  it("omits missing/required clauses when schema has no required fields", () => {
    const hint = buildValidationHint("t", { properties: {} }, { a: 1 });
    expect(hint).toBe('Invalid arguments for "t". You sent: a.');
  });
});

describe("enrichInvalidParams", () => {
  const schema = { required: ["startDate"], properties: {} };

  it("appends a hint to an InvalidParams McpError", () => {
    const original = new McpError(
      ErrorCode.InvalidParams,
      "startDate: Required",
    );
    const enriched = enrichInvalidParams(original, "t", schema, {});
    expect(enriched).toBeInstanceOf(McpError);
    expect((enriched as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((enriched as McpError).message).toContain("startDate: Required");
    expect((enriched as McpError).message).toContain(
      "Missing required: startDate",
    );
    // The SDK prefix must appear exactly once, not doubled.
    expect((enriched as McpError).message).not.toContain("-32602: MCP error");
  });

  it("passes through non-InvalidParams errors untouched", () => {
    const other = new McpError(ErrorCode.MethodNotFound, "nope");
    expect(enrichInvalidParams(other, "t", schema, {})).toBe(other);
    const plain = new Error("boom");
    expect(enrichInvalidParams(plain, "t", schema, {})).toBe(plain);
  });

  it("passes through when the tool name is unknown", () => {
    const original = new McpError(ErrorCode.InvalidParams, "bad");
    expect(enrichInvalidParams(original, undefined, schema, {})).toBe(original);
  });
});

describe("coerceArgsToSchema", () => {
  const schema = {
    properties: {
      postName: { type: "string" },
      patch: { type: "object" },
      sections: { type: "array" },
      save: { type: "boolean" },
      limit: { type: "integer" },
      ratio: { type: "number" },
    },
  };

  it("parses a JSON string into the declared object/array", () => {
    const out = coerceArgsToSchema(schema, {
      patch: '{"sections":[1]}',
      sections: "[1,2]",
    });
    expect(out).toEqual({ patch: { sections: [1] }, sections: [1, 2] });
  });

  it('reads "true"/"false" and numeric strings', () => {
    expect(coerceArgsToSchema(schema, { save: "true" })).toEqual({
      save: true,
    });
    expect(coerceArgsToSchema(schema, { save: "false" })).toEqual({
      save: false,
    });
    expect(coerceArgsToSchema(schema, { limit: "10", ratio: "1.5" })).toEqual({
      limit: 10,
      ratio: 1.5,
    });
  });

  it("never reinterprets a string-typed parameter", () => {
    expect(coerceArgsToSchema(schema, { postName: '{"a":1}' })).toBeNull();
  });

  it("leaves values it cannot read as the declared type", () => {
    // unparseable, wrong parsed type, non-boolean word, non-integer number
    expect(coerceArgsToSchema(schema, { patch: "not json" })).toBeNull();
    expect(coerceArgsToSchema(schema, { patch: "[1,2]" })).toBeNull();
    expect(coerceArgsToSchema(schema, { save: "yes" })).toBeNull();
    expect(coerceArgsToSchema(schema, { limit: "1.5" })).toBeNull();
  });

  it("returns null when nothing changed, and keeps untouched keys", () => {
    expect(
      coerceArgsToSchema(schema, { patch: { a: 1 }, save: true }),
    ).toBeNull();
    expect(coerceArgsToSchema(undefined, { save: "true" })).toBeNull();
    expect(coerceArgsToSchema(schema, undefined)).toBeNull();
    expect(
      coerceArgsToSchema(schema, { postName: "p", save: "true", other: 1 }),
    ).toEqual({ postName: "p", save: true, other: 1 });
  });
});

describe("invalidParamsResultText", () => {
  const errorResult = (text: string) => ({
    isError: true,
    content: [{ type: "text", text }],
  });

  it("returns the text of an argument-validation failure", () => {
    expect(
      invalidParamsResultText(
        errorResult("MCP error -32602: Input validation error: ..."),
      ),
    ).toContain("-32602");
  });

  it("ignores results from a tool that ran and failed on its own terms", () => {
    expect(invalidParamsResultText(errorResult("Post not found"))).toBeNull();
    expect(
      invalidParamsResultText({
        isError: false,
        content: [{ type: "text", text: "MCP error -32602" }],
      }),
    ).toBeNull();
    expect(invalidParamsResultText(null)).toBeNull();
    expect(invalidParamsResultText({ isError: true })).toBeNull();
  });
});

describe("appendHintToResult", () => {
  it("appends to the first text block and leaves the rest alone", () => {
    const result = {
      isError: true,
      content: [
        { type: "text", text: "bad args" },
        { type: "text", text: "trailing" },
      ],
    };
    const out = appendHintToResult(result, "hint");
    expect(out.content[0]!.text).toBe("bad args\n\nhint");
    expect(out.content[1]!.text).toBe("trailing");
    expect(out.isError).toBe(true);
    // input is not mutated
    expect(result.content[0]!.text).toBe("bad args");
  });
});
