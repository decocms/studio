/**
 * PLAN_CASE_NEXT_QUESTION — the next question of the Plan page's guided intro.
 *
 * The agent that builds a business case takes many seconds a turn, too slow
 * for a person answering questions one screen at a time. This asks the org's
 * `fast` tier, from the idea and the answers so far, whether something only
 * the person knows is still missing and, if so, the one question to ask next.
 * The agent then gets the idea and every answer at once and only researches.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { BUSINESS_CASE_LIMITS } from "@decocms/shared/business-case";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { retry } from "@decocms/shared/std";
import { defineTool } from "../../core/define-tool";
import { resolveTier } from "../../core/resolve-tier";
import { requireAuth, requireOrganization } from "../../core/studio-context";

/** More than this and the intro stops asking: the agent assumes the rest. */
const PLAN_CASE_MAX_QUESTIONS = 5;
const MAX_OPTIONS = 4;
const REACTION_MAX = 160;

const InputSchema = z.object({
  idea: z.string().trim().min(1).max(BUSINESS_CASE_LIMITS.text),
  objective: z.string().max(BUSINESS_CASE_LIMITS.text).nullable().optional(),
  answers: z
    .array(
      z.object({
        question: z.string().min(1).max(BUSINESS_CASE_LIMITS.item),
        /** Empty when the person skipped the question. */
        answer: z.string().max(BUSINESS_CASE_LIMITS.text),
      }),
    )
    .max(PLAN_CASE_MAX_QUESTIONS),
});

const OutputSchema = z.object({
  /** One short line about the last answer; null on the first step. */
  reaction: z.string().max(REACTION_MAX).nullable(),
  /** Null when the intro has what it needs and the case can be built. */
  question: z
    .object({
      text: z.string().min(1).max(BUSINESS_CASE_LIMITS.item),
      options: z.array(z.string().min(1).max(80)).max(MAX_OPTIONS),
    })
    .nullable(),
  /** The change as a short action, for the case title; null to keep the idea. */
  title: z.string().min(1).max(BUSINESS_CASE_LIMITS.title).nullable(),
});

/** What the model writes. Plain strings, "" for none: every provider's
 *  structured output handles them, not all handle nullable fields. */
const ModelSchema = z.object({
  reaction: z
    .string()
    .describe(
      'One short, warm sentence about the last answer, e.g. "Good goal, and easy to measure." Empty on the first step.',
    ),
  question: z
    .string()
    .describe(
      "The one question to ask next, or empty when nothing the person knows is missing.",
    ),
  options: z
    .array(z.string())
    .describe(
      "2 to 4 concrete answers to that question, the recommended one first. Empty when there is no question.",
    ),
  title: z
    .string()
    .describe(
      'The change as a short action, under 80 characters, e.g. "Suggest terms when search finds nothing".',
    ),
});

const SYSTEM = `You run the short intro before a business case is built for a change to an online store. A person typed an idea. A research agent will build the case afterwards; your only job is to find out what ONLY the person knows, one question at a time, and stop as soon as you have it.

The case has these cards:
- scope — where in the store, on which device, and what exactly changes. The person decides this.
- measurement — the metric that proves it worked and what must not get worse. The person knows what they care about.
- effort — deadline, budget or team constraints. Only the person knows.
- risks — what they are afraid of breaking. Only the person knows.
- problem (measured), money at stake, competitors, A/B test size, unknowns — the agent researches these from data and the web. NEVER ask about them, and never ask the person for numbers.
- The store goal: if none is given, you may ask what they want to achieve with this change.

Rules:
- Ask about scope first when the idea does not say where and what ("I want to improve search" does not say what in search).
- One thing per question, short and friendly, in the person's words. Never two questions in one.
- Give 2 to 4 options built from this idea and this store area, not a generic list; the recommended one first.
- Ask only what changes the case. Two or three questions are usually enough; zero when the idea already says where and what and nothing else only the person knows is missing.
- A skipped question (empty answer) is not asked again; the agent will assume it.
- Return an empty question when you have enough.
- reaction: one short sentence reacting to the LAST answer specifically, warm and natural; empty when there are no answers yet.
- Write everything in the language the idea is written in.`;

function userMessage(input: z.infer<typeof InputSchema>): string {
  const lines = [`Idea: ${input.idea}`];
  const objective = input.objective?.trim();
  lines.push(objective ? `Store goal: ${objective}` : "Store goal: none");
  if (input.answers.length === 0) {
    lines.push("No questions asked yet.");
  } else {
    lines.push("Questions so far:");
    for (const { question, answer } of input.answers) {
      lines.push(`- Q: ${question}`);
      lines.push(`  A: ${answer.trim() || "(skipped)"}`);
    }
  }
  return lines.join("\n");
}

function clean(value: string, max: number): string | null {
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

export const PLAN_CASE_NEXT_QUESTION = defineTool({
  name: "PLAN_CASE_NEXT_QUESTION",
  description:
    "For the Plan page's guided intro: from a store-change idea and the answers so far, return the next question only the person can answer (with options and a short reaction to the last answer), or no question when the business case can be built. Runs on the organization's fast model tier. Saves nothing.",
  annotations: {
    title: "Next Business Case Question",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  requiresAiBudget: true,

  handler: async (input, ctx, call) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    const settings = await ctx.storage.organizationSettings.get(org.id);
    if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) {
      throw new Error("The Plan page is not enabled for this organization");
    }

    if (input.answers.length >= PLAN_CASE_MAX_QUESTIONS) {
      return { reaction: null, question: null, title: null };
    }

    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, org.id);
    const model = provider.aiSdk.languageModel(tier.modelId);
    const signal = call?.signal;

    const { object } = await retry(
      () =>
        generateObject({
          model,
          schema: ModelSchema,
          instructions: SYSTEM,
          prompt: userMessage(input),
          temperature: 0.4,
          ...(signal ? { abortSignal: signal } : {}),
        }),
      {
        maxAttempts: 2,
        minTimeout: 200,
        maxTimeout: 1_000,
        isRetriable: (err) => (err as Error)?.name !== "AbortError",
        ...(signal ? { signal } : {}),
      },
    );

    const text = clean(object.question, BUSINESS_CASE_LIMITS.item);
    const options = text
      ? object.options
          .map((option) => option.trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, MAX_OPTIONS)
      : [];
    return {
      reaction:
        input.answers.length > 0 ? clean(object.reaction, REACTION_MAX) : null,
      question: text ? { text, options } : null,
      title: clean(object.title, BUSINESS_CASE_LIMITS.title),
    };
  },
});
