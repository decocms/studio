import { describe, expect, test } from "bun:test";
import { createGenerateImageTool } from "./generate-image";

const writer = { write: () => {} } as never;
const objectStorage = {
  put: async () => ({ key: "k" }),
  presignedGetUrl: async (k: string) => `https://s.example/${k}`,
} as never;
const provider = { aiSdk: { imageModel: () => ({}) as never } } as never;

describe("createGenerateImageTool", () => {
  test("builds a tool from objectStorage hook (no ctx)", () => {
    const tool = createGenerateImageTool(writer, {
      provider,
      imageModelInfo: { id: "image-model-1" },
      objectStorage,
      allowHttpExternalUrls: false,
    });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });
});
