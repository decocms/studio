import { describe, expect, test } from "bun:test";
import {
  isOwnVersion,
  ownVersionsTrackedKeyCount,
  rememberOwnVersion,
} from "./use-save-block";

describe("ownVersions tracking", () => {
  test("remembers a value as the caller's own", () => {
    const key = `test:remember:${crypto.randomUUID()}`;
    rememberOwnVersion(key, { a: 1 });
    expect(isOwnVersion(key, { a: 1 })).toBe(true);
    expect(isOwnVersion(key, { a: 2 })).toBe(false);
  });

  test("caps the number of tracked keys, evicting the least recently used", () => {
    const prefix = `test:cap:${crypto.randomUUID()}:`;
    // One more than the 200-key cap.
    for (let i = 0; i < 201; i++) {
      rememberOwnVersion(`${prefix}${i}`, { i });
    }
    expect(ownVersionsTrackedKeyCount()).toBeLessThanOrEqual(200);
    // The oldest key was evicted...
    expect(isOwnVersion(`${prefix}0`, { i: 0 })).toBe(false);
    // ...but a recently written one survives.
    expect(isOwnVersion(`${prefix}200`, { i: 200 })).toBe(true);
  });
});
