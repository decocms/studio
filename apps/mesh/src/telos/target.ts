// The org's enduring Goal (big-G): a fixed, outcome-framed purpose WE author —
// "100x your storefront operation". A Goal is a DESTINATION, not a plan: it carries
// no steps. The engine derives the steps toward it by comparing the Goal to the
// observed world (see domain.ts). The Goal is never an LLM guess and is pursued
// continuously — reaching the engine's current curriculum is a milestone, not a
// terminal state.
export interface Goal {
  // Stable id so the engine can pick a curriculum for it, e.g. "storefront-100x".
  id: string;
  // The purpose, outcome-framed, e.g. "100x your storefront operation".
  title: string;
}

// A specific external app the user should wire up. Matched against a real
// connection and installable in place via its registry `appName`. Used by the
// engine's curriculum and the UI connect checklist.
export interface ToolTarget {
  // Human-facing name, e.g. "GitHub".
  label: string;
  // Lowercase keywords matched (substring) against a connection's app_name /
  // slug / title, e.g. ["github"].
  match: string[];
  // Registry binding id used to install the app in-place
  // (useInstallFromRegistry.installByBinding), e.g. "@deco/github".
  appName?: string;
  icon?: string;
}
