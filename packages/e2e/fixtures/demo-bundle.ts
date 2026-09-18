// Synthetic wire fixture; the review environment imports the actual repository + Reports builds.
const base =
  "<!doctype html><html><head><title>Fixture storefront</title></head><body><h1>Fixture catalog</h1></body></html>";
const search = base.replace(
  "</body>",
  '<input type="search" aria-label="Search products"></body>',
);
const promotion = base.replace(
  "</body>",
  '<p id="countdown">23:59:59</p></body>',
);
const combined = search.replace(
  "</body>",
  '<p id="countdown">23:59:59</p></body>',
);
const recipe = (title: string) => ({
  title,
  description: title,
  steps: [
    "Repository inspected.",
    "The header now has a search field.",
    "Prepared result ready.",
  ],
  result: "Prepared result ready.",
  diff: 'diff --git a/src/Header.tsx b/src/Header.tsx\n+<input type="search" />',
});
export const demoBundle = {
  version: 1,
  source: {
    repository: "fixture/storefront",
    commit: "a".repeat(40),
    reportsCommit: "b".repeat(40),
    siteUrl: "https://shop.example.test/",
    capturedAt: "2026-01-01T00:00:00.000Z",
  },
  assets: {},
  recipes: {
    search: recipe("Make product search visible in the header"),
    promotion: recipe("Add a colorful promotional bar with a countdown"),
    diagnostic: recipe("Verify the report accessibility finding"),
  },
  storefront: {
    base,
    search,
    promotion,
    diagnostic: base,
    "search,promotion": combined,
    "search,diagnostic": search,
    "promotion,diagnostic": promotion,
    "search,promotion,diagnostic": combined,
  },
  reportsHtml: "<html><body>Reports fixture resource</body></html>",
  diagnostic: {
    url: "https://shop.example.test/",
    scope: "public",
    scanned_at: "2026-01-01T00:00:00.000Z",
    lang: "en",
    langs: ["en"],
    default_lang: "en",
    findings_lang: "en",
    meta: { brand: "Fixture" },
    summary: { findings: [{ check_id: "A11Y-028" }] },
    sections: [{ section_type: "cover", props: { brand: "Fixture" } }],
    results: [],
  },
};
