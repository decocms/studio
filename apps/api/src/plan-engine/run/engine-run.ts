/**
 * What one step of a diagnosis run works with: the run's organization, read
 * through a context bound to the member who started it, and the engine's
 * ports on that context. Rebuilt in every step, on whatever pod runs it.
 */

import type { StudioContext } from "@/core/studio-context";
import type { CostEventDraft } from "@/storage/plan-engine-costs";
import { orgLlm } from "../adapters/llm.ts";
import { orgMediaStore } from "../adapters/media.ts";
import {
  openRunBrowser,
  type RunBrowser,
  releaseRunBrowser,
} from "../adapters/run-browser.ts";
import type { Llm, MediaStore } from "../ports.ts";

export interface EngineRun {
  orgId: string;
  /** The diagnosis this run works on. */
  id: string;
  /** The member who started it. */
  userId: string;
  /** A "verify again" round's tag; its media goes under its own prefix. */
  runTag: string | undefined;
  ctx: StudioContext;
  store: StudioContext["storage"]["planEngine"];
  knowledge: StudioContext["storage"]["planEngineKnowledge"];
  llm: Llm;
  /** The org's object storage for the run's media; null when the install has none. */
  media: MediaStore | null;
  /** A URL the model can fetch a stored capture from. */
  mediaUrl: (path: string) => Promise<string>;
  /** The run's browser, provisioned on the step's first call. */
  browser: () => Promise<RunBrowser>;
  /** Removes the run's browser sandbox; never fails. */
  releaseBrowser: () => Promise<void>;
  /** Best effort: the ledger never fails a step. */
  recordCosts: (
    scope: string,
    drafts: readonly CostEventDraft[],
  ) => Promise<void>;
}

/** A context for `userId` acting in `orgId`; null when they left the org. */
export type RunContextFactory = (
  orgId: string,
  userId: string,
) => Promise<StudioContext | null>;

let contextFactory: RunContextFactory | null = null;

/** Wired at boot, before DBOS launches. */
export function setPlanEngineContextFactory(factory: RunContextFactory): void {
  contextFactory = factory;
}

export async function openRun(input: {
  orgId: string;
  userId: string;
  diagnosisId: string;
  runTag?: string;
}): Promise<EngineRun> {
  if (!contextFactory) {
    throw new Error(
      "[plan-engine] context factory not initialized: setPlanEngineContextFactory() must run before the workflow",
    );
  }
  const ctx = await contextFactory(input.orgId, input.userId);
  if (!ctx) {
    throw new Error("quem começou a análise não é mais membro da organização");
  }
  return runOn(ctx, input);
}

function runOn(
  ctx: StudioContext,
  input: {
    orgId: string;
    userId: string;
    diagnosisId: string;
    runTag?: string;
  },
): EngineRun {
  const { orgId, userId, diagnosisId } = input;
  const media = ctx.objectStorage ? orgMediaStore(ctx.objectStorage) : null;
  let browser: Promise<RunBrowser> | null = null;
  return {
    orgId,
    id: diagnosisId,
    userId,
    runTag: input.runTag,
    ctx,
    store: ctx.storage.planEngine,
    knowledge: ctx.storage.planEngineKnowledge,
    llm: orgLlm(ctx),
    media,
    mediaUrl: async (path) => (media ? media.url(path) : path),
    browser: () => {
      browser ??= openRunBrowser({ ctx, orgId, userId, diagnosisId, media });
      return browser;
    },
    releaseBrowser: () =>
      releaseRunBrowser({ ctx, orgId, userId, diagnosisId }),
    recordCosts: async (scope, drafts) => {
      try {
        await ctx.storage.planEngineCosts.insertCostEvents(
          orgId,
          scope,
          drafts,
        );
      } catch (err) {
        console.warn(
          `[plan-engine] spend not recorded (${scope}):`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}
