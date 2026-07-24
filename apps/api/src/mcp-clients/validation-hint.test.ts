import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { buildValidationHint, enrichInvalidParams } from "./validation-hint";

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
