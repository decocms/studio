import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";
import { retryGenerateObject } from "../blog/generate-object";
import { assertOwnsSite } from "./ownership";

const MAX_PROMPT_CHARS = 2_000;

const SuggestedVariantSchema = z.object({
  id: z
    .string()
    .describe(
      "Arm id. The unchanged/baseline arm is always exactly `control` — never a synonym for it. Other arms get a short kebab-case id describing what changes, e.g. `treatment` for a simple on/off test, or `larger-cta`/`urgency-copy` for a named variant.",
    ),
  weight: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Percent of visitors assigned to this arm. All arms sum to 100."),
  role: z.enum(["control", "treatment"]),
  description: z
    .string()
    .describe(
      "One sentence, in the same language as the operator's prompt: what THIS arm specifically shows or does, concrete enough that someone could implement it without re-reading the prompt.",
    ),
});

const SuggestExperimentOutputSchema = z.object({
  key: z
    .string()
    .describe(
      "A short kebab-case identifier for this test, e.g. `valentine-banner`. Used as the manifest key and the traffic-split test name — stable, no spaces, no punctuation beyond hyphens.",
    ),
  name: z
    .string()
    .describe(
      'A human-readable name for the experiment list, in the same language as the prompt, e.g. "Valentine\'s Day banner".',
    ),
  hypothesis: z
    .string()
    .describe(
      "One or two sentences, same language as the prompt: what we expect to happen and why, phrased as a hypothesis a reviewer can agree or disagree with.",
    ),
  variants: z
    .array(SuggestedVariantSchema)
    .min(2)
    .describe(
      "Exactly the arms implied by the prompt — most requests describe a simple control/treatment split, but follow the prompt if it names more arms.",
    ),
});

export const EXPERIMENT_SUGGEST = defineTool({
  name: "EXPERIMENT_SUGGEST",
  description:
    "Turn a plain-language description of an A/B test into a structured proposal: key, name, hypothesis, and variants with traffic-split weights and per-arm descriptions. Does not create or persist anything — the caller reviews and edits the proposal, then calls EXPERIMENT_CREATE.",
  annotations: {
    title: "Suggest Experiment From Prompt",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe(
        "The operator's own description of the experiment, in their own words and language — e.g. \"Valentine's Day banner shows to 50% of users, doesn't show to the other 50%\".",
      ),
  }),
  outputSchema: SuggestExperimentOutputSchema,
  modelSummary: (r) =>
    `Proposed "${r.name}" (${r.key}): ${r.variants.map((v) => `${v.id} ${v.weight}%`).join(", ")}. Not yet created.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organization.id,
    );

    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: SuggestExperimentOutputSchema,
      system: `You turn a plain-language A/B test description into a structured proposal for this store's experiment tool.

The tool this feeds resolves each visitor's arm client-side (a per-visitor traffic split, not a server-side content swap) — so weights are the actual live percentage of visitors, and each arm's description must be concrete enough for an engineer to implement it as a small conditional in the site's existing code. You are not writing the implementation, only specifying what each arm should do.

RULES:
- Reply in the same language the operator used in their prompt.
- Weights are integers and sum to exactly 100. Default to an even split unless the prompt states otherwise.
- One arm's role is always "control" — the unchanged/baseline behavior — even when the prompt only describes the new behavior (infer that control means "nothing changes").
- Keep \`key\` short, kebab-case, and derived from what the test actually does, not generic ("valentine-banner", not "test-1").
- If the prompt is ambiguous about the split, default to 50/50 for a two-arm test.
- When the prompt asks to hide, remove, or not show an existing element for some share of visitors (e.g. "ocultar o banner pra 50%"), say so explicitly and unambiguously in that arm's description — state that the element is not rendered/removed, not just that something "changes". Name the specific element. The other arm's description must state just as explicitly that the element keeps showing normally (this is usually the control). Avoid vague phrasing like "diferente" or "ajustado" for a hide case — an engineer reading only this sentence must be able to tell whether their arm renders the element or not.`,
      prompt: `Describe the experiment implied by this operator prompt:\n\n"""\n${input.prompt}\n"""`,
    });

    return object;
  },
});
