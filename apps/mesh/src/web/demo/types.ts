import type { ComponentType } from "react";
import type { Director } from "./director";
import type { DemoStores } from "./director-stores";

/**
 * A demo screenplay. `run` drives the Director top-to-bottom; `Stage` is the
 * React layout that renders this scenario's tracks/chrome (single chat, a
 * multi-agent grid, a terminal + panes, …). The autoplay loop calls `run`
 * repeatedly, resetting state between runs — keep it idempotent.
 */
export interface Scenario {
  id: string;
  title: string;
  Stage: ComponentType<{ stores: DemoStores }>;
  run: (d: Director) => Promise<void>;
}
