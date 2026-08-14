import { expect, test } from "bun:test";
import { connectionFormSchema } from "./schema";

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
