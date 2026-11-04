import { describe, expect, test } from "bun:test";
import { decofilePatchRefusal } from "./block-write-guards";

/**
 * These refusals used to live in the HTTP handler, which meant they only ever
 * applied to the browser. They are tested here as the repository's rules
 * because a tool now writes through the same coalescer, and a key that is
 * unsafe is unsafe whoever sent it.
 */
describe("decofilePatchRefusal", () => {
  test("lets an ordinary block through", () => {
    expect(
      decofilePatchRefusal({
        set: { "blog-manager/posts/abc": { name: "x", post: {} } },
      }),
    ).toBeNull();
  });

  test("refuses a key that climbs out of the blocks folder", () => {
    expect(
      decofilePatchRefusal({ set: { "../../etc/passwd": {} } }),
    ).not.toBeNull();
  });

  test("checks the keys being deleted, not only the ones being written", () => {
    expect(decofilePatchRefusal({ delete: ["../escape"] })).not.toBeNull();
  });

  test("refuses a block that is not an object", () => {
    expect(decofilePatchRefusal({ set: { "a/b": "just a string" } })).toBe(
      'Block "a/b" must be a JSON object',
    );
  });

  test("refuses an array, which is an object to typeof and not a block", () => {
    expect(decofilePatchRefusal({ set: { "a/b": [] } })).toBe(
      'Block "a/b" must be a JSON object',
    );
  });

  test("refuses null for the same reason", () => {
    expect(decofilePatchRefusal({ set: { "a/b": null } })).toBe(
      'Block "a/b" must be a JSON object',
    );
  });

  test("refuses a key shaped like a framework resolver module", () => {
    expect(decofilePatchRefusal({ set: { "site/loaders/Thing.ts": {} } })).toBe(
      'Block key "site/loaders/Thing.ts" collides with a framework resolver module and cannot be written',
    );
  });

  test("still allows deleting one, so a shadowed resolver is repairable", () => {
    expect(
      decofilePatchRefusal({ delete: ["site/loaders/Thing.ts"] }),
    ).toBeNull();
  });

  test("an empty patch refuses nothing", () => {
    expect(decofilePatchRefusal({})).toBeNull();
  });
});
