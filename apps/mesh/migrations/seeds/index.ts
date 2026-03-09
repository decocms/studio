/**
 * Seeds Index
 *
 * Registry of available database seeds.
 * Seeds are used to populate the database with test/demo data after migrations.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../src/storage/types";

export type { BenchmarkSeedResult } from "./benchmark";
export type { DemoSeedResult } from "./demo/index";

/**
 * Seed function signature
 */
export type SeedFunction<T = unknown> = (db: Kysely<Database>) => Promise<T>;

/**
 * Available seeds registry
 */
const seeds = {
  benchmark: () => import("./benchmark").then((m) => m.seed),
  demo: () => import("./demo").then((m) => m.seed),
} as const;

export type SeedName = keyof typeof seeds;

/**
 * Run a specific seed by name
 */
export async function runSeed<T = unknown>(
  db: Kysely<Database>,
  seedName: SeedName,
): Promise<T> {
  const getSeed = seeds[seedName];
  if (!getSeed) {
    throw new Error(
      `Unknown seed: ${seedName}. Available: ${Object.keys(seeds).join(", ")}`,
    );
  }

  const seedFn = await getSeed();
  console.log(`🌱 Running seed: ${seedName}`);
  const result = await seedFn(db);
  console.log(`✅ Seed "${seedName}" completed`);
  return result as T;
}

/**
 * List available seeds
 */
export function listSeeds(): SeedName[] {
  return Object.keys(seeds) as SeedName[];
}

export default seeds;
