import { describe, expect, test } from "bun:test";
import {
  adoptBlockLoad,
  blockIsLoaded,
  blocksAreLoaded,
  parseBlocksResult,
  type BlockLoadSnapshot,
} from "./block-load";
import type { ContentIndex } from "./hosted-content";

const before = {
  __resolveType: "cms-settings",
  telemetry: { enabled: true },
  analytics: { enabled: true },
};
const after = { ...before, analytics: { enabled: false } };
function snapshot(body: unknown = before, version = "v1"): BlockLoadSnapshot {
  const index: ContentIndex = {
    revision: version,
    resolvedRef: "release",
    sequence: 1,
    entries: { CMS: { version } },
    draft: { CMS: { operation: "set", version, editor: null } },
  };
  return {
    index,
    blocks: body === undefined ? {} : { CMS: body },
    versions: { CMS: version },
  };
}
const answer = (body = before, version = "v1") => ({
  blocks: { CMS: body },
  versions: { CMS: version },
  missing: [],
});

describe("adversarial CMS body-load ordering", () => {
  test("a late read cannot overwrite a newer confirmed save", () => {
    const started = snapshot();
    const saved = snapshot(after, "v2");
    const result = adoptBlockLoad(started, saved, answer());
    expect(result.blocks).toBe(saved.blocks);
    expect(result.versions).toBe(saved.versions);
    expect(result.blocks.CMS).toBe(after);
    expect(blockIsLoaded({ ...saved, ...result }, "CMS")).toBe(true);
  });

  test("an optimistic edit is preserved before its version changes", () => {
    const started = snapshot();
    const editing = { ...started, blocks: { CMS: after } };
    const result = adoptBlockLoad(started, editing, answer());
    expect(result.blocks.CMS).toBe(after);
    expect(result.versions).toBe(editing.versions);
  });

  test("a late read cannot resurrect a deleted block or a cleared scope", () => {
    const started = snapshot();
    const deleted = {
      ...started,
      index: { ...started.index!, entries: {} },
      blocks: {},
      versions: {},
    };
    expect(adoptBlockLoad(started, deleted, answer()).blocks).toEqual({});
    expect(
      adoptBlockLoad(
        started,
        { index: undefined, blocks: {}, versions: {} },
        answer(),
      ).blocks,
    ).toEqual({});
  });

  test("a moved index rejects an old body and does not report it loaded", () => {
    const started = snapshot();
    const moved = { ...started, index: snapshot(after, "v2").index };
    const result = adoptBlockLoad(started, moved, answer());
    expect(result.blocks).toBe(moved.blocks);
    expect(blockIsLoaded({ ...moved, ...result }, "CMS")).toBe(false);
    expect(blocksAreLoaded({ ...moved, ...result }, ["CMS"])).toBe(false);
  });

  test("a newer server version refreshes the index before adopting its body", () => {
    const started = snapshot();
    const result = adoptBlockLoad(started, started, answer(after, "v2"));
    expect(result.refreshIndex).toBe(true);
    expect(result.blocks.CMS).toBe(before);
  });

  test("missing bodies do not delete an indexed copy while its index is stale", () => {
    const started = snapshot();
    const result = adoptBlockLoad(started, started, {
      blocks: {},
      versions: {},
      missing: ["CMS"],
    });
    expect(result.refreshIndex).toBe(true);
    expect(result.blocks.CMS).toBe(before);
  });

  test("a matching read fills only its slot and preserves unrelated edits", () => {
    const started = snapshot();
    const other = { title: "unsaved" };
    const current = { ...started, blocks: { ...started.blocks, Other: other } };
    const result = adoptBlockLoad(started, current, answer());
    expect(result.blocks.Other).toBe(other);
    expect(result.blocks.CMS).toEqual(before);
  });

  test("cache readiness cannot mount a form still receiving a placeholder or old body", () => {
    const current = snapshot(after, "v2");
    expect(
      blocksAreLoaded(current, ["CMS"], { CMS: { __indexStub: true } }),
    ).toBe(false);
    expect(blocksAreLoaded(current, ["CMS"], { CMS: before })).toBe(false);
    expect(blocksAreLoaded(current, ["CMS"], {})).toBe(false);
    expect(blocksAreLoaded(current, ["CMS"], { CMS: after })).toBe(true);
    expect(blocksAreLoaded({ ...current, index: undefined }, ["CMS"], {})).toBe(
      false,
    );
    const deleted = { ...current, index: { ...current.index!, entries: {} } };
    expect(blocksAreLoaded(deleted, ["CMS"], { CMS: before })).toBe(false);
    expect(
      blocksAreLoaded(deleted, ["CMS"], { CMS: { __indexStub: true } }),
    ).toBe(false);
    expect(blocksAreLoaded(deleted, ["CMS"], {})).toBe(true);
  });
});

describe("CMS block response contract", () => {
  test("accepts complete, missing and empty requested sets", () => {
    expect(parseBlocksResult(answer(), ["CMS"])).toEqual(answer());
    expect(
      parseBlocksResult({ blocks: {}, versions: {}, missing: ["CMS"] }, ["CMS"])
        .missing,
    ).toEqual(["CMS"]);
    expect(
      parseBlocksResult({ blocks: {}, versions: {}, missing: [] }, []),
    ).toEqual({ blocks: {}, versions: {}, missing: [] });
  });
  test.each([
    null,
    {},
    { blocks: { CMS: before }, versions: {}, missing: [] },
    { blocks: {}, versions: { CMS: "v1" }, missing: ["CMS"] },
    { ...answer(), missing: ["CMS"] },
    { blocks: {}, versions: {}, missing: ["CMS", "CMS"] },
    { blocks: {}, versions: {}, missing: [] },
    { ...answer(), versions: { CMS: "" } },
    { ...answer(), blocks: { CMS: { __indexStub: true } } },
    { ...answer(), blocks: { CMS: { sections: [{ __indexStub: true }] } } },
    { ...answer(), blocks: { CMS: null } },
    { ...answer(), blocks: { CMS: [] } },
    { blocks: { Other: before }, versions: { Other: "v1" }, missing: [] },
  ])(
    "rejects incomplete, duplicate, injected or placeholder replies %#",
    (result) => {
      expect(() => parseBlocksResult(result, ["CMS"])).toThrow();
    },
  );
});
