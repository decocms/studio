import { describe, expect, test } from "bun:test";
import type { SiteSources } from "../types.ts";
import { browserGap, codeAccessFor } from "./unavailable.ts";

const sources = (repository: SiteSources["repository"]): SiteSources => ({
  detected_at: "2026-11-20T00:00:00.000Z",
  studio_project: null,
  repository,
  errors: [],
});

describe("codeAccessFor", () => {
  test("a site project without a repository: the customer links one", () => {
    expect(
      codeAccessFor({ code_repo: null, sources: sources(null) }).gap,
    ).toMatchObject({ source: "github", owner: "customer", key: "repository" });
    expect(codeAccessFor(null).gap.owner).toBe("customer");
  });

  test("with a repository, reading it is ours to add", () => {
    const { gap } = codeAccessFor({
      code_repo: null,
      sources: sources({ owner: "acme", name: "loja", connection_id: null }),
    });
    expect(gap.source).toBe("github");
    expect(gap.owner).toBeUndefined();
    expect(gap.error).toStartWith("código indisponível:");
  });
});

test("the browser gap is ours", () => {
  expect(browserGap()).toEqual({
    source: "browser",
    error: "navegador indisponível nesta instalação",
  });
});
