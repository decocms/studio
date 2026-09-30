/**
 * LOCAL DEV ONLY — writes the actual `useExperiment(key)` hook + its gate
 * into a local site's own source, right when the operator creates the
 * experiment. No sandbox, no PR, no Super Agent: one bounded LLM call to
 * pick the file + insertion point, then a deterministic file write — same
 * shape and same safety envelope as `EXPERIMENT_PREVIEW_SYNC_LOCAL`'s
 * manifest write, just for the component code instead of the manifest.
 *
 * No-ops (returns `implemented: false`) unless `AB_TESTING_LOCAL_SITE_PATH`
 * is set in this API server's environment — never call this expecting it to
 * affect anything beyond one developer's local checkout.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { assertOwnsSite } from "./ownership";
import { resolveTier } from "../../core/resolve-tier";
import { retryGenerateObject } from "../blog/generate-object";

const SCAN_DIRS = ["src/sections", "src/components"];
const MAX_CANDIDATE_FILES = 6;
const MAX_FILE_CHARS = 6_000;

async function walk(dir: string): Promise<string[]> {
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
      files.push(...(await walk(full)));
    } else if (/\.(tsx|jsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
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
    await Promise.all(SCAN_DIRS.map((d) => walk(path.join(sitePath, d))))
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
      "False when none of the candidate files plausibly render the element the variants describe — the caller then does nothing rather than guess.",
    ),
  hookExportName: z
    .string()
    .optional()
    .describe("camelCase, e.g. `useDealsNavbarVisibilityExperiment`."),
  hookFileContent: z
    .string()
    .optional()
    .describe(
      "Full contents of the new hook file — a one-line wrapper around useExperiment(key), matching the style of the existing example given.",
    ),
  targetFile: z
    .string()
    .optional()
    .describe("Relative path, exactly one of the candidate files given."),
  importLine: z
    .string()
    .optional()
    .describe("The import statement to add to targetFile."),
  anchorLine: z
    .string()
    .optional()
    .describe(
      "One line copied VERBATIM from targetFile's given content — the new gate is inserted immediately after this exact line. Must be an exact substring match.",
    ),
  insertCode: z
    .string()
    .optional()
    .describe(
      "The gate to insert right after anchorLine — a hook call plus a conditional early return/skip, matching the style of the existing example.",
    ),
});

export const EXPERIMENT_IMPLEMENT_LOCAL = defineTool({
  name: "EXPERIMENT_IMPLEMENT_LOCAL",
  description:
    "LOCAL DEV ONLY. Writes a useExperiment(key) hook and its gate directly into a local site's source, so the experiment takes effect immediately in local dev — no sandbox, no PR. No-ops (returns implemented:false) unless AB_TESTING_LOCAL_SITE_PATH is set in this API server's environment.",
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
    hookFile: z.string().optional(),
    targetFile: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);

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

    let existingHookExample = "";
    try {
      const abTestingDir = path.join(sitePath, "src/ab-testing");
      const files = await readdir(abTestingDir);
      const exampleFile = files.find(
        (f) => f.endsWith(".ts") && f !== "index.ts",
      );
      if (exampleFile) {
        existingHookExample = await readFile(
          path.join(abTestingDir, exampleFile),
          "utf8",
        );
      }
    } catch {
      // No existing hook to imitate — the model still has the schema's
      // description of the expected shape to go on.
    }

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organization.id,
    );

    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: PatchSchema,
      system: `You wire an A/B test's variants into this site's actual frontend code. The site already has a convention for this — a small hook wrapping \`useExperiment(key)\` under \`src/ab-testing/\`, and a one-line conditional gate added directly in the component that renders the affected element. Here is one such existing hook, to imitate exactly in style:\n\n${existingHookExample || '(none found — invent a matching shape: a named function wrapping useExperiment(key) from "@decocms/tanstack", returning its result.)'}\n\nYou are given a shortlist of files that might render the element the variants describe. Pick the right one — or say \`found: false\` if none plausibly do, rather than guessing. \`anchorLine\` must be copied verbatim from the file you pick, so the caller can find it with a plain string search; if you can't find a safe, unambiguous line to anchor on, say \`found: false\`.`,
      prompt: `Test key: \`${input.key}\`\n\nVariants:\n${input.variants
        .map(
          (v) =>
            `- ${v.id} (${v.role ?? "arm"}): ${v.description ?? "no description"}`,
        )
        .join("\n")}\n\nCandidate files:\n\n${candidates
        .map((c) => `--- ${c.path} ---\n${c.content}`)
        .join("\n\n")}`,
    });

    if (
      !object.found ||
      !object.hookExportName ||
      !object.hookFileContent ||
      !object.targetFile ||
      !object.importLine ||
      !object.anchorLine ||
      !object.insertCode
    ) {
      return { implemented: false, reason: "model found no confident match" };
    }

    const targetAbsolute = path.join(sitePath, object.targetFile);
    let targetContent: string;
    try {
      targetContent = await readFile(targetAbsolute, "utf8");
    } catch {
      return { implemented: false, reason: "target file unreadable" };
    }
    if (!targetContent.includes(object.anchorLine)) {
      return { implemented: false, reason: "anchor line not found verbatim" };
    }

    const hookFileName = `${object.hookExportName}.ts`;
    const hookPath = path.join(sitePath, "src/ab-testing", hookFileName);
    await writeFile(hookPath, object.hookFileContent, "utf8");

    const indexPath = path.join(sitePath, "src/ab-testing/index.ts");
    const indexContent = await readFile(indexPath, "utf8").catch(() => "");
    if (!indexContent.includes(object.hookExportName)) {
      await writeFile(
        indexPath,
        `${indexContent.trimEnd()}\nexport { ${object.hookExportName} } from "./${object.hookExportName}";\n`,
        "utf8",
      );
    }

    const patched = targetContent.replace(
      object.anchorLine,
      `${object.anchorLine}\n${object.insertCode}`,
    );
    const withImport = patched.includes(object.importLine)
      ? patched
      : patched.replace(/^(import .+\n)/, `$1${object.importLine}\n`);
    await writeFile(targetAbsolute, withImport, "utf8");

    return {
      implemented: true,
      hookFile: path.join("src/ab-testing", hookFileName),
      targetFile: object.targetFile,
    };
  },
});
