/**
 * Public, full-screen Demo Mode player (`/demo/$scenario`).
 *
 * Plays a SINGLE scenario on a loop — no cross-scenario auto-advance. Each demo
 * has its own URL so they can be shared/linked independently.
 */
import { useParams } from "@tanstack/react-router";
import { DemoStage } from "@/web/demo/stage";
import { SCENARIO_BY_ID, SCENARIOS } from "@/web/demo/scenarios";

export default function DemoScenarioRoute() {
  const { scenario } = useParams({ strict: false }) as { scenario?: string };
  const found = (scenario && SCENARIO_BY_ID[scenario]) || SCENARIOS[0]!;
  // Single-element array ⇒ the runner replays just this scenario.
  return <DemoStage key={found.id} scenarios={[found]} />;
}
