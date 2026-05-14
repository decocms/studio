import { describe, expect, test } from "bun:test";
import { derivePartsFromTiptapDoc } from "./derive-parts.ts";

function mentionDoc(metadata: unknown) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "mention",
            attrs: {
              id: "predict-and-apply",
              name: "Predict And Apply",
              char: "/",
              metadata,
            },
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof derivePartsFromTiptapDoc>[0];
}

describe("derivePartsFromTiptapDoc — prompt mention roles", () => {
  test("includes prompt body when role is assistant", () => {
    const parts = derivePartsFromTiptapDoc(
      mentionDoc([
        { role: "assistant", content: { type: "text", text: "Do the thing." } },
      ]),
    );
    const texts = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
    expect(texts.some((t) => t.includes("Do the thing."))).toBe(true);
  });

  test("includes prompt body when role is system", () => {
    const parts = derivePartsFromTiptapDoc(
      mentionDoc([
        { role: "system", content: { type: "text", text: "Be precise." } },
      ]),
    );
    const texts = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
    expect(texts.some((t) => t.includes("Be precise."))).toBe(true);
  });

  test("still includes prompt body when role is user (regression)", () => {
    const parts = derivePartsFromTiptapDoc(
      mentionDoc([
        { role: "user", content: { type: "text", text: "Run it." } },
      ]),
    );
    const texts = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
    expect(texts.some((t) => t.includes("Run it."))).toBe(true);
  });

  test("converts non-user image content to a file part", () => {
    const parts = derivePartsFromTiptapDoc(
      mentionDoc([
        {
          role: "assistant",
          content: { type: "image", data: "AAA", mimeType: "image/png" },
        },
      ]),
    );
    const filePart = parts.find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    expect((filePart as { mediaType: string }).mediaType).toBe("image/png");
  });

  test("skips prompt messages whose content is empty", () => {
    const parts = derivePartsFromTiptapDoc(
      mentionDoc([{ role: "assistant", content: null }]),
    );
    const nonLabelTexts = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .filter((t) => t !== "/Predict And Apply");
    expect(nonLabelTexts).toHaveLength(0);
  });
});
