import { retryGenerateObject } from "./generate-object";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";
import { BlogBrandSchema, BlogGenerationSchema } from "./schema";
import {
  EvidenceBlocksSchema,
  EvidenceSeoSchema,
  renderEvidence,
} from "./evidence-prompt";
import {
  applyVerdicts,
  type FieldSpec,
  flattenClaims,
  judgeClaims,
  logDiscarded,
  verbatimExamples,
} from "./confidence";

const SYSTEM = `You are writing down HOW a brand writes, so that blogposts generated later read as if the brand wrote them itself. Every field of the output schema says what it wants and where to find it — work through them field by field.

You are given the brand's profile — who the company is, what it sells, who reads it — already inferred from this same site. Take it as established fact and do not restate it: your job is the writing rules, which the profile alone cannot tell you. What you produce is injected verbatim into the prompt that writes each post, so write for a writer who has never seen this site.

Your input is Deco CMS blocks from a site's own repository, serialized as JSON and labelled with their block keys. Blog post and category blocks are the strongest evidence when they exist, because that is the brand writing posts. Many commerce sites have no blog at all, only page blocks (they carry a \`path\` and a \`sections\` array) — then page copy is all you get, and you work with it.

Prose is scattered across prop names, not held in one body field. Harvest it from every prop whose value reads like a sentence or a phrase a person wrote: \`text\`, \`title\`, \`description\`, \`label\`, \`caption\`, \`alt\`, and HTML fragments stored as strings (\`"<p>…</p>"\` — read through the tags). Short values count: \`alt: "92% de funcionárias"\` and \`alt: "do rio pro mundo"\` tell you more about a voice than a whole layout tree.

Four traps in real block data:

1. INTERNAL ANNOTATIONS ARE NOT COPY. Editors label assets for themselves: \`"[LP Rio - lojix] [carrossel detalhes]"\`, \`"Banner lojix"\`, \`"Desktop"\`, \`"20px"\`. Bracketed prefixes, campaign codenames, asset filenames and dimension labels are internal shorthand. Never quote them as brand voice.

2. OPERATIONAL AND LEGAL COPY IS NOT EDITORIAL VOICE. Shipping thresholds, return windows, payment restrictions and promotion terms are written by a different hand for a different purpose — treating them as voice yields fine print instead of a brand.

3. BRAND-SPECIFIC VOCABULARY IS THE MOST VALUABLE THING HERE. When a brand renames an ordinary thing, capture it verbatim as a \`dos\` entry: a site that writes "verifique os detalhes direto na sua mochila" calls the shopping bag a *mochila*, and one that writes "o seu desejo tamanho M não está disponível" calls a product a *desejo*. A generated post that says "carrinho" instead would read as an impostor. Same for recurring one-word imperatives the brand uses as sign-offs ("vem").

4. CASING AND PUNCTUATION ARE PART OF THE VOICE. If sentences and the brand's own name are consistently lowercase, that is a deliberate choice and belongs in \`tone\` and in \`dos\`. Watch for inconsistency too: when the same sentence appears in two casings, the brand has no settled rule, so do not invent one.

THE SEO SECTION IS THE BRAND AT ITS MOST DELIBERATE. A title and a description are rewritten until a team agrees on them, so they show the voice with the hesitation taken out — the sentence length it settles on, the casing it means, the words it reaches for first. Read them for \`tone\` and \`vocabulary\` before anything else, but never quote one as a \`voiceExample\`: it is a label on a page, not a sentence a reader reads.

Template placeholders like \`{size}\` or \`{name}\` are slots the site fills at render time. Read the sentence around them; never copy the placeholder into your answer.

What separates a usable rule from a useless one:

- A \`dos\` IS AN IMPERATIVE, NOT AN ADJECTIVE. "Abra com o problema do cliente, nunca com a empresa" is a rule a writer can follow; "tom acolhedor" is a label that changes nothing about the post. If a rule does not tell the writer to do something, rewrite it until it does.
- AN \`avoid\` IS NOT A \`dos\` INVERTED. Deriving "nunca abra com a empresa" from the rule above adds nothing and costs the writer attention. A guardrail earns its place by naming something the copy visibly never does, or a claim the brand is visibly careful about, that no \`dos\` already covers.

Three rules that override everything else:
1. WRITE EVERY FIELD IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in the profile you are given. These instructions are in English because they are instructions; the rules are content, and content follows the brand. Mixing the two languages makes them unusable — they are read by people who work in that language, and they are fed to a model that will copy the language it sees.
2. Every field must rest on prose you actually read here. Fidelity to how THIS brand writes beats how a brand in its category usually writes.
3. No evidence means empty — an empty string or an empty array. A plausible-sounding guess is worse than a blank field, because someone will read it as fact and every post generated afterwards inherits it. A human reviews this afterwards and can fill a blank; they cannot un-read a confident invention.`;

function renderRules(
  label: string,
  rules: { name: string; value: string }[] | undefined,
): string | null {
  if (!rules?.length) return null;
  const lines = rules
    .map((r) => `- ${r.name}${r.value ? `: ${r.value}` : ""}`)
    .join("\n");
  return `## ${label}\n${lines}`;
}

/** The brand profile as prose, skipping whatever hasn't been filled in. */
function renderBrand(brand: Partial<z.infer<typeof BlogBrandSchema>>): string {
  return (
    [
      brand.companyName && `## Brand\n${brand.companyName}`,
      brand.description && `## What it does\n${brand.description}`,
      brand.language && `## Language to write in\n${brand.language}`,
      brand.targetAudience && `## Audience\n${brand.targetAudience}`,
      renderRules("Brand values", brand.values),
      renderRules("Competitors", brand.competitors),
    ]
      .filter(Boolean)
      .join("\n\n") || "No brand profile has been filled in yet."
  );
}

/**
 * What the gate judges, and what relevance is asking of each field.
 *
 * `categories` is left out: it is a taxonomy of plain names, where "is this
 * true" has no meaning and the UI discards the answer anyway.
 */
const CONTEXT_FIELD_SPECS: readonly FieldSpec[] = [
  {
    field: "tone",
    kind: "text",
    origin: "blocks",
    purpose:
      "Could another writer reproduce this brand's voice from this description alone — how the reader is addressed, sentence length, formality, jargon level?",
  },
  {
    field: "dos",
    kind: "rules",
    origin: "blocks",
    purpose:
      "Is it an imperative a writer could follow, drawn from something the copy consistently does? An adjective rather than an instruction is 29 at most.",
  },
  {
    field: "avoid",
    kind: "rules",
    origin: "blocks",
    purpose:
      "Is it a real prohibition this copy observes? Another rule stated inverted, with nothing new to act on, is 29 at most.",
  },
  {
    field: "vocabulary",
    kind: "rules",
    origin: "blocks",
    purpose:
      "Is this genuinely the brand's own word for something, displacing an ordinary one a writer would otherwise reach for? A product or feature name the brand capitalises is exactly what this field is for — the whole point is that a post using the generic word reads as an impostor.",
  },
  {
    field: "voiceExamples",
    kind: "examples",
    origin: "blocks",
    purpose:
      "Does the sentence SHOW how this brand sounds, so that matching its register would make a post sound like it? It does not need to change what a post says — that is not what an example is for. Score it as a specimen of the voice. Only a sentence so bland it would sit in any brand's copy, or one that is a shipping term or an editor's note rather than something a customer reads, falls below 60.",
  },
];
export const BLOG_CONTEXT_EXTRACT = defineTool({
  name: "BLOG_CONTEXT_EXTRACT",
  description:
    "Infer how a brand's blog is written (tone of voice, editorial instructions, guardrails, categories) by reading its own CMS blocks against the brand profile BLOG_BRAND_EXTRACT produced. Does not persist — the caller saves the result to the site's blog-manager-context.json block.",
  annotations: {
    title: "Extract Blog Writing Context",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    brand: BlogBrandSchema.partial().describe(
      "Who the brand is, as BLOG_BRAND_EXTRACT inferred it. Every field is optional — a half-filled profile is the normal case — but the more of it is filled, the better grounded the rules are.",
    ),
    blocks: EvidenceBlocksSchema,
    seo: EvidenceSeoSchema,
  }),

  outputSchema: BlogGenerationSchema.extend({
    sources: z.array(z.string()).describe("Block keys the inference read"),
    discarded: z
      .number()
      .describe(
        "Claims the confidence judge rejected, and that this result therefore omits. Their text and scores go to the server log, never on the wire.",
      ),
    judged: z
      .boolean()
      .describe(
        "False when the judge was unavailable or answered incompletely — then nothing was filtered and every field is the raw extraction.",
      ),
  }),

  // Every one of these is token spend, and a spent envelope has to stop it —
  // the margin stop the usage bar was otherwise only reporting.
  requiresAiBudget: true,

  modelSummary: (r) =>
    `Writing context inferred from ${r.sources.length} block(s): tone captured, ${r.dos.length} dos, ${r.avoid.length} don'ts, ${r.categories.length} categories. ${r.judged ? `${r.discarded} claim(s) fell below the confidence bar and were dropped` : "The confidence judge did not run, so nothing was filtered"}. Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const evidence = renderEvidence(input);
    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: BlogGenerationSchema,
      system: SYSTEM,
      prompt: [
        `# The brand, already established\n\n${renderBrand(input.brand)}`,
        evidence,
      ].join("\n\n---\n\n"),
    });

    const written: Record<string, unknown> = {
      ...object,
      // A quote that isn't in the evidence isn't a quote, and no judge is
      // needed to say so.
      voiceExamples: verbatimExamples(object.voiceExamples, evidence),
    };

    const claims = flattenClaims(written, CONTEXT_FIELD_SPECS);
    const gate = applyVerdicts(
      written,
      claims,
      await judgeClaims(
        ctx,
        organizationId,
        { evidence, claims, specs: CONTEXT_FIELD_SPECS },
        "BLOG_CONTEXT_EXTRACT",
      ),
      CONTEXT_FIELD_SPECS,
    );
    logDiscarded("BLOG_CONTEXT_EXTRACT", gate);

    return {
      ...(gate.kept as z.infer<typeof BlogGenerationSchema>),
      discarded: gate.discarded.length,
      judged: gate.judged,
      sources: input.blocks.map((b) => b.key),
    };
  },
});
