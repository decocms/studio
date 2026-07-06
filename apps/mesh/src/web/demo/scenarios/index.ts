/** Demo scenario registry — each gets its own URL (`/demo/<id>`). */
import { turtlesScenario } from "./turtles";
import { dayZeroScenario } from "./day-zero";
import type { Scenario } from "../types";

export const SCENARIOS: Scenario[] = [turtlesScenario, dayZeroScenario];

export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
);
