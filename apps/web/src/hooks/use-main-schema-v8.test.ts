import { describe, expect, test } from "bun:test";
import { BLOCKS_V8_METADATA_KEY } from "@decocms/shared/blocks-major";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { lastFoundV8, projectMainSchemaAnswer } from "./use-main-schema-v8";

const project = (metadata: Record<string, unknown> | null) =>
  ({ id: "p", metadata }) as unknown as VirtualMCPEntity;

describe("projectMainSchemaAnswer (the Blocks v8 site switch alone)", () => {
  test("a project an org admin made a Blocks v8 site is v8", () => {
    const on = project({ [BLOCKS_V8_METADATA_KEY]: true });
    expect(projectMainSchemaAnswer(on)).toBe("v8");
    expect(lastFoundV8(on)).toBe(true);
  });

  test("the switch off, a stale v8 marker or no project is v7", () => {
    for (const p of [
      project(null),
      project({}),
      project({ [BLOCKS_V8_METADATA_KEY]: "true" }),
      project({ blocksMajor: 8 }),
      null,
    ]) {
      expect(projectMainSchemaAnswer(p)).toBe("v7");
      expect(lastFoundV8(p)).toBe(false);
    }
  });
});
