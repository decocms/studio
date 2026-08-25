import { describe, expect, test } from "bun:test";
import { stripBindingMetadata } from "./headers";

describe("stripBindingMetadata", () => {
  test("strips __binding from a top-level object value", () => {
    const input = {
      connection: {
        __type: "@deco/database",
        value: "conn_1",
        __binding: [{ name: "QUERY" }],
      },
    };
    expect(stripBindingMetadata(input)).toEqual({
      connection: { __type: "@deco/database", value: "conn_1" },
    });
  });

  test("strips __binding from array items", () => {
    const input = {
      connections: [
        {
          __type: "@deco/database",
          value: "conn_1",
          __binding: [{ name: "QUERY" }],
        },
        {
          __type: "@deco/database",
          value: "conn_2",
          __binding: [{ name: "QUERY" }],
        },
      ],
    };
    expect(stripBindingMetadata(input)).toEqual({
      connections: [
        { __type: "@deco/database", value: "conn_1" },
        { __type: "@deco/database", value: "conn_2" },
      ],
    });
  });

  test("strips __binding nested inside a grouped object", () => {
    const input = {
      group: {
        connection: {
          __type: "@deco/llm",
          value: "conn_3",
          __binding: [{ name: "CHAT" }],
        },
      },
    };
    expect(stripBindingMetadata(input)).toEqual({
      group: {
        connection: { __type: "@deco/llm", value: "conn_3" },
      },
    });
  });

  test("leaves values without __binding unchanged", () => {
    const input = { foo: "bar", nested: { baz: 1 } };
    expect(stripBindingMetadata(input)).toEqual(input);
  });

  test("passes through non-object values", () => {
    expect(stripBindingMetadata(null)).toBeNull();
    expect(stripBindingMetadata(undefined)).toBeUndefined();
    expect(stripBindingMetadata("x")).toBe("x");
  });
});
