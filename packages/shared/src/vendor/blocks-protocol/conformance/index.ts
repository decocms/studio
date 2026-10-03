/**
 * `@decocms/blocks/protocol/conformance`: a black-box test suite any
 * content-protocol endpoint runs over HTTP, which is how the filesystem
 * storage, the site editor's GitHub backend and any other backend are kept to
 * the same contract.
 *
 * Run it with any test runner:
 *
 * ```ts
 * import { describe, it } from "vitest";
 * import { defineConformanceSuite } from "@decocms/blocks/protocol/conformance";
 *
 * defineConformanceSuite({ describe, it }, { endpoint: "http://127.0.0.1:4545/rpc", token });
 * ```
 *
 * or collect a report with `runConformance(options)`. The suite writes only
 * names under its own prefix and deletes them after each case (uploads, which
 * the protocol can't delete, stay in the asset folder). Cases that
 * don't apply to an endpoint (a read-only one, one without request keys)
 * skip themselves. Browser-safe: it only needs `fetch`.
 */
import { assetCases } from "./cases/assets";
import { guardCases } from "./cases/guards";
import { readCases } from "./cases/reads";
import type { ConformanceCase } from "./cases/types";
import { wireCases } from "./cases/wire";
import { writeCases } from "./cases/writes";
import {
  ConformanceContext,
  type ConformanceOptions,
  SkipCase,
} from "./context";

export type { ConformanceCase } from "./cases/types";
export {
  type ContentHashFixture,
  contentHashFixtures,
} from "./content-hash-fixtures";
export {
  assert,
  assertEqual,
  ConformanceContext,
  ConformanceFailure,
  type ConformanceOptions,
  expectError,
  type RawResponse,
  rawErrorCode,
  SkipCase,
} from "./context";

/** Every conformance case, in the order they run. */
export const conformanceCases: readonly ConformanceCase[] = [
  ...wireCases,
  ...readCases,
  ...writeCases,
  ...guardCases,
  ...assetCases,
];

function defaultPrefix(): string {
  return `conformance-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CaseOutcome {
  id: string;
  title: string;
  status: "passed" | "failed" | "skipped";
  /** Why it failed or was skipped. */
  message?: string;
}

/** Runs one case with its own names, cleaning them up afterwards. */
export async function runCase(
  testCase: ConformanceCase,
  options: ConformanceOptions,
  prefix: string,
): Promise<CaseOutcome> {
  const ctx = new ConformanceContext(options, prefix);
  try {
    await testCase.run(ctx);
    return { id: testCase.id, title: testCase.title, status: "passed" };
  } catch (error) {
    if (error instanceof SkipCase) {
      return {
        id: testCase.id,
        title: testCase.title,
        status: "skipped",
        message: error.message,
      };
    }
    return {
      id: testCase.id,
      title: testCase.title,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await ctx.cleanup();
  }
}

export interface ConformanceReport {
  passed: number;
  failed: number;
  skipped: number;
  outcomes: CaseOutcome[];
}

/** Runs every case (or the ones `filter` keeps) in order and reports the outcomes. */
export async function runConformance(
  options: ConformanceOptions,
  filter: (testCase: ConformanceCase) => boolean = () => true,
): Promise<ConformanceReport> {
  const prefix = options.namePrefix ?? defaultPrefix();
  const outcomes: CaseOutcome[] = [];
  let index = 0;
  for (const testCase of conformanceCases.filter(filter)) {
    outcomes.push(await runCase(testCase, options, `${prefix}-${++index}`));
  }
  const count = (status: CaseOutcome["status"]) =>
    outcomes.filter((o) => o.status === status).length;
  return {
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    outcomes,
  };
}

/** The parts of a test runner the suite registers itself with (vitest, jest, node:test, bun:test). */
export interface TestRegistrar {
  describe(name: string, body: () => void): void;
  it(
    name: string,
    body: (context?: { skip?: (note?: string) => void }) => Promise<void>,
    timeout?: number,
  ): void;
}

/** Registers one test per conformance case with a test runner. */
export function defineConformanceSuite(
  runner: TestRegistrar,
  options: ConformanceOptions | (() => ConformanceOptions),
  suiteName = "content protocol conformance",
  filter: (testCase: ConformanceCase) => boolean = () => true,
): void {
  const resolve = typeof options === "function" ? options : () => options;
  const prefix = defaultPrefix();
  runner.describe(suiteName, () => {
    conformanceCases.filter(filter).forEach((testCase, index) => {
      runner.it(
        `${testCase.id}: ${testCase.title}`,
        async (context) => {
          const resolved = resolve();
          const outcome = await runCase(
            testCase,
            resolved,
            `${resolved.namePrefix ?? prefix}-${index + 1}`,
          );
          if (outcome.status === "failed") throw new Error(outcome.message);
          if (outcome.status === "skipped") context?.skip?.(outcome.message);
        },
        60_000,
      );
    });
  });
}
