import { describe, expect, test } from "bun:test";
import { BLOCKS_V8_METADATA_KEY } from "@decocms/shared/blocks-major";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { blocksV8Project } from "./use-blocks-v8-project";

const project = (metadata: Record<string, unknown> | null) =>
  ({ id: "p", metadata }) as unknown as VirtualMCPEntity;

describe("blocksV8Project (the Blocks v8 site switch alone)", () => {
  test("a project an org admin made a Blocks v8 site is v8", () => {
    expect(blocksV8Project(project({ [BLOCKS_V8_METADATA_KEY]: true }))).toBe(
      true,
    );
  });

  test("the switch off, a stale v8 marker or no project is v7", () => {
    for (const p of [
      project(null),
      project({}),
      project({ [BLOCKS_V8_METADATA_KEY]: "true" }),
      project({ blocksMajor: 8 }),
      null,
    ]) {
      expect(blocksV8Project(p)).toBe(false);
    }
  });
});
