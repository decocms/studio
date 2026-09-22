import { describe, expect, test } from "bun:test";
import {
  sanitizeCustomHeaders,
  serializeRunMetadataHeader,
  stripBindingMetadata,
} from "./headers";

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

describe("serializeRunMetadataHeader", () => {
  test("returns null for undefined or empty metadata", () => {
    expect(serializeRunMetadataHeader(undefined)).toBeNull();
    expect(serializeRunMetadataHeader({})).toBeNull();
  });

  test("serializes small metadata to JSON", () => {
    expect(serializeRunMetadataHeader({ taskBoardItemId: "abc" })).toBe(
      JSON.stringify({ taskBoardItemId: "abc" }),
    );
  });

  test("drops metadata that would exceed the header size cap", () => {
    const oversized = { note: "x".repeat(9 * 1024) };
    expect(serializeRunMetadataHeader(oversized)).toBeNull();
  });

  test("drops metadata whose byte size exceeds the cap despite a smaller UTF-16 length", () => {
    // 3000 4-byte emoji: ~12KB in bytes, under 8K in UTF-16 code units.
    const oversized = { note: "\u{1F600}".repeat(3000) };
    expect(serializeRunMetadataHeader(oversized)).toBeNull();
  });

  test("drops metadata outside the HTTP header ByteString range", () => {
    const nonLatin1 = { title: "日本語のタイトル" };
    expect(serializeRunMetadataHeader(nonLatin1)).toBeNull();
  });

  test("keeps metadata whose characters are all within the Latin-1 byte range", () => {
    const latin1 = { note: "café" };
    expect(serializeRunMetadataHeader(latin1)).toBe(JSON.stringify(latin1));
  });
});

describe("sanitizeCustomHeaders CR/LF guard", () => {
  test("drops a header value containing a raw CRLF", () => {
    expect(
      sanitizeCustomHeaders({
        "X-Api-Key": "abc123",
        "X-Injected": "value\r\nX-Evil: 1",
      }),
    ).toEqual({ "X-Api-Key": "abc123" });
  });

  test("drops a header value containing a lone LF or CR", () => {
    expect(
      sanitizeCustomHeaders({
        "X-Lf": "value\ninjected",
        "X-Cr": "value\rinjected",
      }),
    ).toEqual({});
  });

  test("drops a header whose key contains an injected CRLF", () => {
    expect(
      sanitizeCustomHeaders({
        "X-Api-Key": "abc123",
        "X-Injected\r\nX-Evil: 1": "value",
      }),
    ).toEqual({ "X-Api-Key": "abc123" });
  });
});

describe("sanitizeCustomHeaders reserved-name guard", () => {
  test("drops a custom header that would override the Authorization header", () => {
    expect(
      sanitizeCustomHeaders({
        "X-Api-Key": "abc123",
        Authorization: "Bearer spoofed",
      }),
    ).toEqual({ "X-Api-Key": "abc123" });
  });

  test("drops a reserved name regardless of case", () => {
    expect(
      sanitizeCustomHeaders({
        "x-caller-id": "spoofed-connection",
        "X-Studio-Token": "spoofed-token",
      }),
    ).toEqual({});
  });
});

describe("sanitizeCustomHeaders", () => {
  test("returns an empty object for undefined headers", () => {
    expect(sanitizeCustomHeaders(undefined)).toEqual({});
  });

  test("keeps safe, small header values unchanged", () => {
    expect(sanitizeCustomHeaders({ "X-Api-Key": "abc123" })).toEqual({
      "X-Api-Key": "abc123",
    });
  });

  test("drops a header value outside the HTTP header ByteString range", () => {
    expect(
      sanitizeCustomHeaders({
        "X-Api-Key": "abc123",
        "X-Title": "日本語のタイトル",
      }),
    ).toEqual({ "X-Api-Key": "abc123" });
  });

  test("drops a header value exceeding the size cap", () => {
    expect(
      sanitizeCustomHeaders({
        "X-Api-Key": "abc123",
        "X-Oversized": "x".repeat(9 * 1024),
      }),
    ).toEqual({ "X-Api-Key": "abc123" });
  });
});
