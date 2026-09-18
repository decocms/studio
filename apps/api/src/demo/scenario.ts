import type { DemoRecipe } from "@decocms/shared/demo";

export const seedTasks: {
  key: string;
  recipe: DemoRecipe;
  status: string;
}[] = [
  { key: "search", recipe: "search", status: "todo" },
  { key: "promotion", recipe: "promotion", status: "todo" },
  { key: "diagnostic", recipe: "diagnostic", status: "todo" },
  {
    key: "search-review",
    recipe: "search",
    status: "in_review",
  },
  {
    key: "promotion-review",
    recipe: "promotion",
    status: "in_review",
  },
  {
    key: "diagnostic-approved",
    recipe: "diagnostic",
    status: "approved",
  },
  {
    key: "search-done",
    recipe: "search",
    status: "done",
  },
  {
    key: "promotion-done",
    recipe: "promotion",
    status: "done",
  },
  {
    key: "search-triage",
    recipe: "search",
    status: "triage",
  },
  {
    key: "promotion-triage",
    recipe: "promotion",
    status: "triage",
  },
];
