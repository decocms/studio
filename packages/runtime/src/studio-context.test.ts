import { describe, expect, test } from "bun:test";
import {
  resolveStudioRequestContext,
  resolveStudioUrl,
} from "./studio-context.ts";

describe("Studio compatibility aliases", () => {
  test("prefers studioUrl and accepts meshUrl as an alias", () => {
    expect(
      resolveStudioUrl({
        studioUrl: "https://studio.example.com",
        meshUrl: "https://legacy.example.com",
      }),
    ).toBe("https://studio.example.com");
    expect(resolveStudioUrl({ meshUrl: "https://legacy.example.com" })).toBe(
      "https://legacy.example.com",
    );
  });

  test("prefers STUDIO_REQUEST_CONTEXT and accepts the legacy key", () => {
    const studioContext = { connectionId: "studio-connection" };
    const legacyContext = { connectionId: "legacy-connection" };

    expect(
      resolveStudioRequestContext({
        STUDIO_REQUEST_CONTEXT: studioContext,
        MESH_REQUEST_CONTEXT: legacyContext,
      }),
    ).toBe(studioContext);
    expect(
      resolveStudioRequestContext({
        MESH_REQUEST_CONTEXT: legacyContext,
      }),
    ).toBe(legacyContext);
  });
});
