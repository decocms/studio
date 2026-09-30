import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { renderField } from "../schema-form";
import type { SchemaProperty } from "../resolve-schema";
import { SecretField } from "./secret-field";

const secretFormat: SchemaProperty = { type: "string", format: "secret" };

describe("renderField secret routing", () => {
  test.each([
    ["the secret loader's `@format secret` prop", secretFormat, "a1b2"],
    ["an empty `@format secret` prop", secretFormat, undefined],
    ["a plaintext `@format secret` prop", secretFormat, "SG.raw"],
    [
      "a `@format password` string",
      { type: "string", format: "password" },
      "x",
    ],
    [
      "a secret loader block value",
      { type: "object" },
      { __resolveType: "website/loaders/secret.ts", encrypted: "a1b2" },
    ],
  ] as const)("renders SecretField for %s", (_, schema, value) => {
    const element = renderField({
      schema,
      value,
      onChange: () => {},
      path: "encrypted",
      label: "Secret Value",
    });
    expect(isValidElement(element) && element.type).toBe(SecretField);
  });

  test("a plain string still renders as a plain field", () => {
    const element = renderField({
      schema: { type: "string" },
      value: "hello",
      onChange: () => {},
      path: "title",
      label: "Title",
    });
    expect(isValidElement(element) && element.type).not.toBe(SecretField);
  });
});
