import { describe, expect, test } from "bun:test";
import { BLOG_POST_ASSEMBLE } from "./post-assemble";
import { BLOG_POST_DRAFT } from "./post-draft";
import { BLOG_SITE_BLOCKS } from "./site-blocks";

/**
 * The two tools that replaced a local script, and the contract between them.
 *
 * Until these existed the block mapping ran only in the browser's bundle, so
 * driving the pipeline from anywhere else needed a checkout and a shell. What
 * made that removable is that neither of these spends a model and neither
 * writes — so a run can be read before anything is committed. Both properties
 * are invisible in the handler and would be easy to give away.
 */

/** Past `.default()` / `.optional()`, which wrap the schema they modify. */
const unwrap = (schema: unknown): Record<string, unknown> => {
  let node = schema as { def?: { innerType?: unknown } };
  while (node?.def?.innerType) node = node.def.innerType as typeof node;
  return node as Record<string, unknown>;
};

const shapeOf = (schema: unknown): Record<string, unknown> =>
  (unwrap(schema) as unknown as { shape: Record<string, unknown> }).shape;

const elementOf = (schema: unknown): unknown =>
  (unwrap(schema) as unknown as { element: unknown }).element;

describe("the site-reading tools stay free and read-only", () => {
  test("neither spends the organization's model budget", () => {
    expect(BLOG_SITE_BLOCKS.requiresAiBudget).toBeUndefined();
    expect(BLOG_POST_ASSEMBLE.requiresAiBudget).toBeUndefined();
  });

  test("neither persists, so a run can be inspected before it commits", () => {
    expect(BLOG_SITE_BLOCKS.annotations?.readOnlyHint).toBe(true);
    expect(BLOG_POST_ASSEMBLE.annotations?.readOnlyHint).toBe(true);
  });

  test("neither reaches outside this organization's own repository", () => {
    expect(BLOG_SITE_BLOCKS.annotations?.openWorldHint).toBe(false);
    expect(BLOG_POST_ASSEMBLE.annotations?.openWorldHint).toBe(false);
  });

  test("both read a branch rather than guessing the default", () => {
    expect(shapeOf(BLOG_SITE_BLOCKS.inputSchema)).toHaveProperty("branch");
    expect(shapeOf(BLOG_POST_ASSEMBLE.inputSchema)).toHaveProperty("branch");
  });
});

describe("what one returns is what the next one takes", () => {
  test("the blocks read off the site satisfy the drafting tool's schema", () => {
    expect(
      Object.keys(
        shapeOf(elementOf(shapeOf(BLOG_SITE_BLOCKS.outputSchema).blocks)),
      ).sort(),
    ).toEqual(
      Object.keys(
        shapeOf(elementOf(shapeOf(BLOG_POST_DRAFT.inputSchema).blocks)),
      ).sort(),
    );
  });

  test("categories and authors come back drafting-ready", () => {
    const read = shapeOf(BLOG_SITE_BLOCKS.outputSchema);
    const draft = shapeOf(BLOG_POST_DRAFT.inputSchema);
    for (const field of ["categories", "authors"] as const) {
      expect(Object.keys(shapeOf(elementOf(read[field]))).sort()).toEqual(
        Object.keys(shapeOf(elementOf(draft[field]))).sort(),
      );
    }
  });

  test("assembling takes a draft shaped like the one drafting returns", () => {
    const written = shapeOf(
      elementOf(shapeOf(BLOG_POST_DRAFT.outputSchema).posts),
    );
    const taken = shapeOf(shapeOf(BLOG_POST_ASSEMBLE.inputSchema).draft);
    for (const field of Object.keys(taken)) {
      expect(written).toHaveProperty(field);
    }
  });

  test("assembling hands the link pass both halves of its input", () => {
    const out = shapeOf(BLOG_POST_ASSEMBLE.outputSchema);
    expect(out).toHaveProperty("bodyText");
    expect(out).toHaveProperty("posts");
  });

  test("the payload is the one the writer takes", () => {
    expect(shapeOf(BLOG_POST_ASSEMBLE.outputSchema)).toHaveProperty("post");
  });
});
