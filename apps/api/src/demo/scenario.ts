import type { DemoRecipe } from "@decocms/shared/demo";

export const recipes: Record<
  DemoRecipe,
  {
    title: string;
    description: string;
    steps: string[];
    result: string;
    before: string;
    after: string;
  }
> = {
  search: {
    title: "Make product search visible in the header",
    description:
      "Add a visible search field with product suggestions. Keep the header clean on mobile and support keyboard navigation.",
    steps: [
      "I checked the storefront header. Search is hidden behind an icon, making products harder to find.",
      "The header now has a search field with instant product suggestions and an accessible empty state.",
      "Keyboard navigation, mobile layout and product links passed the prepared review. The preview is ready for your approval.",
    ],
    result:
      "Search is now visible in the header, with product suggestions and keyboard support.",
    before: '<button aria-label="Search">⌕</button>',
    after:
      '<label>Find your next favorite<input type="search" placeholder="Search products" /></label>\n<ProductSuggestions keyboardNavigation />',
  },
  promotion: {
    title: "Add a colorful promotional bar with a countdown",
    description:
      "Show the weekend offer above the header, with a countdown and a clear call to action. Use a layout that works on mobile.",
    steps: [
      "I reviewed the storefront layout and reserved space above the header for the promotion.",
      "The promotional bar is ready, with a countdown, offer message and link to the collection.",
      "The prepared review passed for narrow screens and keyboard navigation. Compare the preview before approving.",
    ],
    result:
      "The promotional bar includes a countdown and a link to the featured collection.",
    before: "<header><Logo /><Navigation /></header>",
    after:
      '<PromotionBar message="Weekend edit · 20% off" countdown />\n<header><Logo /><Navigation /></header>',
  },
  diagnostic: {
    title: "Add the missing homepage meta description",
    description:
      "The curated storefront diagnostic found no meta description on the baseline homepage. Add a concise description that matches the store catalog.",
    steps: [
      "I reproduced the finding against this scenario's baseline: the homepage has no meta description.",
      "I added a description matching the catalog and kept the existing page title.",
      "The prepared SEO check now passes. The report, diff and preview all use the same scenario version.",
    ],
    result:
      "The homepage now includes a concise meta description. The diagnostic finding is resolved in this preview.",
    before: "<title>Forma · Everyday objects</title>",
    after:
      '<title>Forma · Everyday objects</title>\n<meta name="description" content="Thoughtful everyday objects for your home. Explore the Forma collection." />',
  },
};

export const seedTasks: {
  key: string;
  recipe: DemoRecipe;
  status: string;
  title?: string;
}[] = [
  { key: "search", recipe: "search", status: "todo" },
  { key: "promotion", recipe: "promotion", status: "todo" },
  { key: "diagnostic", recipe: "diagnostic", status: "todo" },
  {
    key: "search-review",
    recipe: "search",
    status: "in_review",
    title: "Review product suggestions on mobile",
  },
  {
    key: "promotion-review",
    recipe: "promotion",
    status: "in_review",
    title: "Review the weekend collection banner",
  },
  {
    key: "diagnostic-approved",
    recipe: "diagnostic",
    status: "approved",
    title: "Approve the collection page description",
  },
  {
    key: "search-done",
    recipe: "search",
    status: "done",
    title: "Improve the search empty state",
  },
  {
    key: "promotion-done",
    recipe: "promotion",
    status: "done",
    title: "Update the featured collection message",
  },
  {
    key: "search-triage",
    recipe: "search",
    status: "triage",
    title: "Explore a more prominent search entry",
  },
  {
    key: "promotion-triage",
    recipe: "promotion",
    status: "triage",
    title: "Plan the next seasonal campaign",
  },
];
