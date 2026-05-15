import type { HarnessFactory, HarnessId } from "./types";

const registry = new Map<HarnessId, HarnessFactory>();

/** Register a harness factory. Called once per harness at module load by
 *  `apps/mesh/src/harnesses/index.ts` (the barrel) — see Task 11. */
export function registerHarnessFactory(factory: HarnessFactory): void {
  registry.set(factory.id, factory);
}

/** Lookup a factory by id. Returns undefined when no factory is registered —
 *  callers should treat that as "harness not supported in this build" and
 *  surface a clear error. */
export function getHarnessFactory(id: HarnessId): HarnessFactory | undefined {
  return registry.get(id);
}

/** Visible to tests only. Clears the registry so tests don't leak. */
export function resetRegistryForTests(): void {
  registry.clear();
}
