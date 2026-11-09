import { describe, expect, test } from "bun:test";
import { parseStructuredBlock } from "./schema";

const message = {
  version: 1 as const,
  author: { name: "Alex Example", avatarUrl: "https://example.com/avatar.png" },
  body: "**Reported issue**",
  url: "https://example.com/message/1",
};
const testing = {
  version: 1 as const,
  previewUrl: "https://preview.example.com/page",
  steps: [{ action: "Drag the list", expected: "Items move" }],
};
describe("structured markdown", () => {
  for (const source of ["gchat", "whatsapp", "slack", "email"])
    test(source, () => {
      expect(
        parseStructuredBlock(source, JSON.stringify(message)),
      ).toMatchObject({ kind: "message", source, data: message });
    });
  test("video attachments work across sources and reject unsafe URLs", () => {
    for (const source of ["gchat", "whatsapp", "slack", "email"]) {
      const attachment = {
        kind: "video",
        name: "Reported behavior.mp4",
        url: "https://example.com/api/org_example/fs/home/read?path=report.mp4",
      };
      expect(
        parseStructuredBlock(
          source,
          JSON.stringify({ ...message, attachments: [attachment] }),
        ),
      ).toMatchObject({ data: { attachments: [attachment] } });
      expect(
        parseStructuredBlock(
          source,
          JSON.stringify({
            ...message,
            attachments: [{ ...attachment, url: "javascript:alert(1)" }],
          }),
        ),
      ).toBeNull();
    }
  });
  test("testing preserves structured links and steps", () => {
    expect(parseStructuredBlock("testing", JSON.stringify(testing))).toEqual({
      kind: "testing",
      data: testing,
    });
  });
  test("version defaults to one", () => {
    expect(
      parseStructuredBlock(
        "gchat",
        JSON.stringify({ author: { name: "Alex" }, body: "Hello" }),
      ),
    ).toMatchObject({ data: { version: 1 } });
  });
  for (const content of [
    "",
    "null",
    "[]",
    "{",
    JSON.stringify({ ...message, version: 2 }),
    JSON.stringify({ ...message, extra: true }),
    JSON.stringify({ ...message, author: { name: " " } }),
    "x".repeat(64001),
  ])
    test(`invalid message ${content.slice(0, 50)}`, () => {
      expect(parseStructuredBlock("gchat", content)).toBeNull();
    });
  for (const url of [
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "file:///etc/passwd",
    "https://user:password@example.com",
    "//example.com",
  ])
    test(`reject unsafe URL ${url}`, () => {
      expect(
        parseStructuredBlock("gchat", JSON.stringify({ ...message, url })),
      ).toBeNull();
      expect(
        parseStructuredBlock(
          "gchat",
          JSON.stringify({
            ...message,
            author: { name: "Alex", avatarUrl: url },
          }),
        ),
      ).toBeNull();
      expect(
        parseStructuredBlock(
          "testing",
          JSON.stringify({ ...testing, previewUrl: url }),
        ),
      ).toBeNull();
    });
  test("empty or oversized steps and invalid timestamps are rejected", () => {
    for (const steps of [
      [],
      Array(31).fill({ action: "test" }),
      [{ action: "" }],
    ])
      expect(
        parseStructuredBlock("testing", JSON.stringify({ ...testing, steps })),
      ).toBeNull();
    expect(
      parseStructuredBlock(
        "gchat",
        JSON.stringify({ ...message, sentAt: "yesterday" }),
      ),
    ).toBeNull();
  });
  test("ordinary code remains code", () => {
    expect(parseStructuredBlock("json", JSON.stringify(message))).toBeNull();
  });
});
