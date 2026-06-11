import { describe, expect, test } from "bun:test";
import { createTakeScreenshotTool } from "./take-screenshot";

const writer = { write: () => {} } as never;
const objectStorage = { put: async () => ({ key: "k" }) } as never;

describe("createTakeScreenshotTool", () => {
  test("builds from objectStorage hook without ctx", () => {
    const tool = createTakeScreenshotTool(writer, {
      objectStorage,
      toolOutputMap: new Map(),
      pendingImages: [],
    });
    expect(typeof tool.execute).toBe("function");
  });
});
