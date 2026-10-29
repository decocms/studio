import { describe, expect, test } from "bun:test";
import { MainSchemaChangedError } from "@/hooks/main-schema-changed";
import { previewGapOf } from "./use-card-preview";

function failed(status: number): Error {
  return Object.assign(new Error(`Failed to fetch decofile: ${status}`), {
    status,
  });
}

describe("previewGapOf", () => {
  test("a plan without the CMS is its own gap", () => {
    expect(previewGapOf(failed(403))).toBe("no-cms");
  });

  test("a site with no preview address or no repository answers 404", () => {
    expect(previewGapOf(failed(404))).toBe("no-preview-server");
  });

  test("anything else is the site being unavailable", () => {
    expect(previewGapOf(failed(500))).toBe("unavailable");
    expect(previewGapOf(new MainSchemaChangedError())).toBe("unavailable");
    expect(previewGapOf(new TypeError("Failed to fetch"))).toBe("unavailable");
    expect(previewGapOf(null)).toBe("unavailable");
  });
});
