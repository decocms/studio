/** Demo scenario registry — each gets its own URL (`/demo/<id>`). */
import { storefrontScenario } from "./storefront";
import { agentsScenario } from "./agents";
import type { Scenario } from "../types";

export const SCENARIOS: Scenario[] = [storefrontScenario, agentsScenario];

export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
);
