import { describe, expect, test } from "bun:test";
import { BLOG_BRAND_ENRICH } from "./brand-enrich";
import { BLOG_BRAND_EXTRACT } from "./brand-extract";

/**
 * Extracting a brand used to read the site, search the web and judge every
 * claim in one request — three model phases behind an edge proxy that gives up
 * at a hundred seconds, which is why it answered 524 in production rather than
 * answering at all.
 *
 * The split is what fixed it, so these pin the split itself: the shapes are
 * what would quietly merge back together, and a reader cannot tell from the
 * handler alone that the separation is load-bearing.
 */
const fieldsOf = (tool: { outputSchema: unknown }): string[] =>
  Object.keys(
    (tool.outputSchema as { shape: Record<string, unknown> }).shape,
  ).sort();

describe("the brand passes stay split", () => {
  const extract = fieldsOf(BLOG_BRAND_EXTRACT);
  const enrich = fieldsOf(BLOG_BRAND_ENRICH);

  test("extracting reports no research, because it does none", () => {
    expect(extract).not.toContain("researchSources");
    expect(extract).not.toContain("searched");
  });

  test("extracting reports no judgement, because it does none", () => {
    expect(extract).not.toContain("discarded");
    expect(extract).not.toContain("judged");
  });

  test("extracting omits the one field only research can answer", () => {
    expect(extract).not.toContain("specialDates");
  });

  test("enriching reports both, since it is the call that does them", () => {
    for (const field of ["researchSources", "searched", "discarded", "judged"])
      expect(enrich).toContain(field);
  });

  test("enriching answers the whole profile, not a patch of it", () => {
    for (const field of ["companyName", "language", "competitors"])
      expect(enrich).toContain(field);
  });

  test("only the reading pass says which blocks it read", () => {
    expect(extract).toContain("sources");
    expect(enrich).not.toContain("sources");
  });

  test("both still refuse without the feature, and both still spend", () => {
    expect(BLOG_BRAND_EXTRACT.requiresAiBudget).toBe(true);
    expect(BLOG_BRAND_ENRICH.requiresAiBudget).toBe(true);
  });

  /** The research pass reaches the open web; the reading pass does not. */
  test("each says whether it leaves the building", () => {
    expect(BLOG_BRAND_EXTRACT.annotations?.openWorldHint).toBe(false);
    expect(BLOG_BRAND_ENRICH.annotations?.openWorldHint).toBe(true);
  });
});
