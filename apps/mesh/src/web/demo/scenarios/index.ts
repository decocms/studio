/** Demo scenario registry — each gets its own URL (`/demo/<id>`). */
import { turtlesScenario } from "./turtles";
import type { Scenario } from "../types";

export const SCENARIOS: Scenario[] = [turtlesScenario];

export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
);
