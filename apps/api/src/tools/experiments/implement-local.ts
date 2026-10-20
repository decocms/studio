/** LOCAL DEV ONLY. CSS, not a component edit: React undoes generated DOM patches on hydration. */

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { assertOwnsSite } from "./ownership";
import { assertExperimentsV2 } from "./v2-gate";
import { resolveTier } from "../../core/resolve-tier";
import { retryGenerateObject } from "../blog/generate-object";

const SCAN_DIRS = ["src/sections", "src/components"];
const MAX_CANDIDATE_FILES = 6;
const MAX_FILE_CHARS = 6_000;

async function walk(dir: string, match: RegExp): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, match)));
    } else if (match.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** The stylesheets the generated rule may be appended to. Listed rather than
 *  created, so the rule lands somewhere the site's build already includes —
 *  a new file nothing imports is the silent-failure shape this repo keeps
 *  hitting elsewhere. */
async function findStylesheets(sitePath: string): Promise<string[]> {
  const files = await walk(path.join(sitePath, "src"), /\.css$/);
  return files.map((f) => path.relative(sitePath, f));
}

/** Ranks every `.tsx`/`.jsx` file under the scanned dirs by how many of the
 *  variant descriptions' significant words it contains — a plain keyword
 *  match, not semantic search, but cheap and good enough to shortlist a
 *  handful of files for the LLM call to actually choose between. */
async function findCandidateFiles(
  sitePath: string,
  descriptions: string[],
): Promise<{ path: string; content: string }[]> {
  const words = new Set(
    descriptions
      .join(" ")
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 4),
  );
  if (words.size === 0) return [];

  const allFiles = (
    await Promise.all(
      SCAN_DIRS.map((d) => walk(path.join(sitePath, d), /\.(tsx|jsx)$/)),
    )
  ).flat();

  const scored: { path: string; content: string; score: number }[] = [];
  for (const file of allFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const score = [...words].reduce(
      (n, w) => (lower.includes(w) ? n + 1 : n),
      0,
    );
    if (score > 0) {
      scored.push({
        path: path.relative(sitePath, file),
        content: content.slice(0, MAX_FILE_CHARS),
        score,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATE_FILES)
    .map(({ path: p, content }) => ({ path: p, content }));
}

const PatchSchema = z.object({
  found: z
    .boolean()
    .describe(
      "False when no candidate file plausibly renders the element the variants describe, OR when the arms can't be expressed as styling. The caller then does nothing rather than guess.",
    ),
  sourceFile: z
    .string()
    .optional()
    .describe(
      "Relative path, exactly one of the candidate files given — the component whose markup the selector targets. Reported back to the operator; not modified.",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "The CSS selector for the affected element, derived from classes or data attributes actually present in sourceFile's markup. Never invented.",
    ),
  cssFile: z
    .string()
    .optional()
    .describe(
      "Relative path, exactly one of the stylesheets given — where the rules are appended.",
    ),
  cssRules: z
    .string()
    .optional()
    .describe(
      'The complete CSS to append: one rule per non-control arm, each keyed on `[data-ab-<key>="<arm-id>"]` scoping `selector`. The control arm gets no rule — it is the page\'s existing behavior.',
    ),
});

export const EXPERIMENT_IMPLEMENT_LOCAL = defineTool({
  name: "EXPERIMENT_IMPLEMENT_LOCAL",
  description:
    "LOCAL DEV ONLY. Appends the experiment's arms to a local site's stylesheet as CSS rules scoped by the deco-ab-testing SDK's `data-ab-<key>` root attribute, so the experiment takes effect immediately in local dev — no sandbox, no PR. Returns implemented:false when the arms aren't expressible as styling, or unless AB_TESTING_LOCAL_SITE_PATH is set in this API server's environment.",
  annotations: {
    title: "Implement Experiment Locally (dev only)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z.string().min(1),
    variants: z
      .array(
        z.object({
          id: z.string(),
          role: z.enum(["control", "treatment"]).nullable().optional(),
          description: z.string().nullable().optional(),
        }),
      )
      .min(1),
  }),
  outputSchema: z.object({
    implemented: z.boolean(),
    reason: z.string().optional(),
    /** The stylesheet the rules were appended to. */
    cssFile: z.string().optional(),
    /** The component the selector targets — reported, never modified. */
    targetFile: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);
    await assertExperimentsV2(ctx, organization.id);

    const sitePath = process.env.AB_TESTING_LOCAL_SITE_PATH;
    if (!sitePath) return { implemented: false, reason: "not configured" };

    const descriptions = input.variants
      .map((v) => v.description)
      .filter((d): d is string => !!d?.trim());
    if (descriptions.length === 0) {
      return { implemented: false, reason: "no variant descriptions" };
    }

    const candidates = await findCandidateFiles(sitePath, descriptions);
    if (candidates.length === 0) {
      return { implemented: false, reason: "no candidate files found" };
    }

    const stylesheets = await findStylesheets(sitePath);
    if (stylesheets.length === 0) {
      return { implemented: false, reason: "no stylesheet to append to" };
    }

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organization.id,
    );

    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: PatchSchema,
      system: `You wire an A/B test's arms into a site instrumented with the deco-ab-testing SDK.

The SDK sets \`data-ab-<test-key>="<arm-id>"\` on the <html> element BEFORE first paint, and hands nothing else over. So each arm is expressed as a plain CSS rule scoped by that attribute:

  [data-ab-${input.key}="some-arm"] .the-affected-element { display: none; }

RULES:
- The control arm is the page's EXISTING behavior. Emit no rule for it.
- \`selector\` must be built from classes or data attributes you can actually SEE in the candidate file's markup. Never invent a class name — a rule that matches nothing fails silently and looks exactly like a working test with no effect.
- Do not write JavaScript, do not reference \`useExperiment\`, and do not propose editing the component. React undoes DOM patches on hydration, intermittently.
- If the arms can't be expressed as styling (they need different text, different data, or conditional logic), or if no candidate file plausibly renders the element, say \`found: false\`. Returning nothing is correct here; a human handles those cases through the pull-request flow.`,
      prompt: `Test key: \`${input.key}\`\n\nArms:\n${input.variants
        .map(
          (v) =>
            `- ${v.id} (${v.role ?? "arm"}): ${v.description ?? "no description"}`,
        )
        .join("\n")}\n\nStylesheets available (pick exactly one):\n${stylesheets
        .map((s) => `- ${s}`)
        .join("\n")}\n\nCandidate files:\n\n${candidates
        .map((c) => `--- ${c.path} ---\n${c.content}`)
        .join("\n\n")}`,
    });

    if (
      !object.found ||
      !object.sourceFile ||
      !object.selector ||
      !object.cssFile ||
      !object.cssRules?.trim()
    ) {
      return { implemented: false, reason: "model found no confident match" };
    }
    // A path outside the list we gave it would write outside the scanned tree.
    if (!stylesheets.includes(object.cssFile)) {
      return { implemented: false, reason: "chose an unknown stylesheet" };
    }
    // An unscoped rule would apply to every visitor, control included.
    if (!object.cssRules.includes(`data-ab-${input.key}`)) {
      return { implemented: false, reason: "rules not scoped to the test" };
    }

    const cssAbsolute = path.join(sitePath, object.cssFile);
    const existing = await readFile(cssAbsolute, "utf8").catch(() => "");
    const banner = `/* A/B test: ${input.key} — generated by Studio Experiments */`;
    if (existing.includes(banner)) {
      return { implemented: false, reason: "already implemented" };
    }
    await writeFile(
      cssAbsolute,
      `${existing.trimEnd()}\n\n${banner}\n${object.cssRules.trim()}\n`,
      "utf8",
    );

    return {
      implemented: true,
      cssFile: object.cssFile,
      targetFile: object.sourceFile,
    };
  },
});
