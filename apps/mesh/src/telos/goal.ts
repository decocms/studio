import type { Goal } from "./target";

// The fixed Goal WE set for every org — a destination, deterministic, no research
// and no LLM, so a goal can never name something we don't support. The engine
// derives the steps toward it (see curriculumFor in domain.ts).
export function buildStudioGoal(): Goal {
  return { id: "storefront-100x", title: "100x your storefront operation" };
}
