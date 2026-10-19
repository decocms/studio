import { expect, test } from "bun:test";
import { configurationScopesFor, connectionFormSchema } from "./schema";

const base = {
  title: "My connection",
  ui_type: "HTTP" as const,
};

test("rejects a non-URL connection_url for HTTP connections", () => {
  const result = connectionFormSchema.safeParse({
    ...base,
    connection_url: "not-a-url",
  });
  expect(result.success).toBe(false);
});

test("accepts a well-formed connection_url", () => {
  const result = connectionFormSchema.safeParse({
    ...base,
    connection_url: "https://example.com/mcp",
  });
  expect(result.success).toBe(true);
});

test("does not require a URL shape for non-HTTP ui_types", () => {
  const result = connectionFormSchema.safeParse({
    title: "My command",
    ui_type: "STDIO",
    stdio_command: "node server.js",
  });
  expect(result.success).toBe(true);
});

test("adds a declared scope once its binding is set", () => {
  const declared = ["VTEX::credential:configuration:read"];
  expect(configurationScopesFor([], declared, {})).toEqual([]);
  expect(
    configurationScopesFor([], declared, {
      VTEX: { __type: "vtex", value: "conn_1" },
    }),
  ).toEqual(declared);
});

test("keeps saved scopes and does not duplicate them", () => {
  expect(
    configurationScopesFor(
      ["A::read", "B::write"],
      ["B::write", "C.nested::read"],
      { A: 1, B: 2, C: { nested: true } },
    ),
  ).toEqual(["A::read", "B::write", "C.nested::read"]);
});
