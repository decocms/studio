import { describe, expect, test } from "bun:test";
import {
  BLOCKS_MAJOR_METADATA_KEY,
  blocksV8Metadata,
} from "@decocms/shared/blocks-major";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { lastFoundV8, projectMainSchemaAnswer } from "./use-main-schema-v8";

const project = (metadata: Record<string, unknown> | null) =>
  ({ id: "p", metadata }) as unknown as VirtualMCPEntity;

describe("projectMainSchemaAnswer (the v8 marker alone)", () => {
  test("a project marked v8 by `deco schema push` is v8", () => {
    const pushed = project(blocksV8Metadata({ site: "acme", sha256: "e1" }));
    expect(projectMainSchemaAnswer(pushed)).toBe("v8");
    expect(lastFoundV8(pushed)).toBe(true);
  });

  test("a stale marker 8 with no CMS schema push is v7 (the v7 editor)", () => {
    const stale = project({ [BLOCKS_MAJOR_METADATA_KEY]: 8 });
    expect(projectMainSchemaAnswer(stale)).toBe("v7");
    expect(lastFoundV8(stale)).toBe(false);
  });

  test("no marker, another major or no project is v7", () => {
    expect(projectMainSchemaAnswer(project(null))).toBe("v7");
    expect(
      projectMainSchemaAnswer(project({ [BLOCKS_MAJOR_METADATA_KEY]: 9 })),
    ).toBe("v7");
    expect(projectMainSchemaAnswer(null)).toBe("v7");
  });
});
