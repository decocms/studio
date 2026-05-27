import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/mesh-context";
import { DEFAULT_THEMES } from "@/page-preview/default-themes";
import {
  appendBlock,
  createDesignSystem,
  createPage,
  DEFAULT_BRAND,
  getBlocks,
  getPagePreviewStatus,
  listDesignSystems,
  refreshPagePreview,
  removeBlock,
  setActiveDesignSystem,
  setPagePreviewActive,
  setPageProgress,
  updateBlock,
} from "@/page-preview/service";

const BrandTokensInputSchema = z.object({
  name: z.string().optional(),
  primary: z.string().optional(),
  secondary: z.string().optional(),
  accent: z.string().optional(),
  bg: z.string().optional(),
  surface: z.string().optional(),
  fg: z.string().optional(),
  muted: z.string().optional(),
  border: z.string().optional(),
  headingFont: z.string().optional(),
  bodyFont: z.string().optional(),
  radius: z.string().optional(),
});

const BrandTokensOutputSchema = z.object({
  name: z.string(),
  primary: z.string(),
  secondary: z.string(),
  accent: z.string(),
  bg: z.string(),
  surface: z.string(),
  fg: z.string(),
  muted: z.string(),
  border: z.string(),
  onPrimary: z.string(),
  onSecondary: z.string(),
  onAccent: z.string(),
  headingFont: z.string(),
  bodyFont: z.string(),
  radius: z.string(),
});

const PagePreviewPageSchema = z.object({
  slug: z.string(),
  name: z.string(),
  designSystem: z.string().nullable(),
  path: z.string(),
  relativePath: z.string(),
  url: z.string(),
  lastModified: z.string(),
});

const DesignSystemEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  brand: BrandTokensOutputSchema,
  path: z.string(),
  relativePath: z.string(),
  url: z.string(),
  lastModified: z.string(),
});

const PagePreviewStatusOutputSchema = z.object({
  pagesDir: z.string(),
  activeKind: z.enum(["page", "design-system"]).nullable(),
  activePath: z.string().nullable(),
  activeRelativePath: z.string().nullable(),
  activeUrl: z.string().nullable(),
  activeDesignSystem: z.string().nullable(),
  refreshVersion: z.number(),
  pages: z.array(PagePreviewPageSchema),
  designSystems: z.array(DesignSystemEntrySchema),
  progressLabel: z.string().nullable(),
  progressUpdatedAt: z.string().nullable(),
  outline: z.array(z.string()).nullable(),
  outlineUpdatedAt: z.string().nullable(),
  nextStep: z.string().optional(),
});

/**
 * Slim output schema for mid-build tools (PROGRESS, RENDER_BLOCK, UPDATE_BLOCK,
 * REMOVE_BLOCK, DESIGN_SYSTEM_CREATE, PAGE_PREVIEW_PAGE_CREATE). The pre-cost-
 * audit shape returned the full PagePreviewStatusOutputSchema — including the
 * `pages` + `designSystems` arrays — on every single one of those tool calls.
 * With 14+ calls per build, that's tens of thousands of tokens accumulated in
 * conversation history for data the agent doesn't need mid-build (Studio polls
 * /api/<org>/page-preview/state separately for status). Slim responses keep
 * input bills proportional to what the agent actually used.
 *
 * Agents that genuinely need the full listing use PAGE_PREVIEW_STATUS.
 */
const PagePreviewSlimOutputSchema = z.object({
  ok: z.literal(true),
  slug: z.string().optional(),
  nextStep: z.string().optional(),
});

function pageSlugFromStatus(
  status: z.infer<typeof PagePreviewStatusOutputSchema>,
): string | null {
  if (status.activeKind !== "page") return null;
  const rel = status.activeRelativePath ?? "";
  const match = rel.match(/^pages\/([^/]+)\//);
  return match?.[1] ?? null;
}

function orgArgs(ctx: Parameters<typeof requireOrganization>[0]) {
  const org = requireOrganization(ctx);
  if (!ctx.objectStorage) {
    throw new Error(
      "Page Editor requires object storage — none was provisioned for this request.",
    );
  }
  return {
    orgId: org.id,
    objectStorage: ctx.objectStorage,
    orgSlug: org.slug ?? org.id,
    baseUrl: ctx.baseUrl,
  };
}

export const PAGE_PREVIEW_STATUS = defineTool({
  name: "PAGE_PREVIEW_STATUS",
  description:
    "Return the local Page Editor pages directory, active preview, refresh version, design systems and discovered pages.",
  annotations: {
    title: "Page Preview Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: PagePreviewStatusOutputSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    return getPagePreviewStatus(args);
  },
});

export const PAGE_PREVIEW_SET = defineTool({
  name: "PAGE_PREVIEW_SET",
  description:
    "Set the Page Editor preview to a page (by slug, e.g. 'pricing', or path under pages/).",
  annotations: {
    title: "Set Page Preview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Page slug (e.g. 'pricing'), relative path (e.g. 'pages/pricing/index.html'), or absolute path inside the Page Editor root.",
      ),
  }),
  outputSchema: PagePreviewStatusOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    const status = await setPagePreviewActive({ ...args, path: input.path });
    const slug = pageSlugFromStatus(status) ?? input.path;
    return {
      ...status,
      nextStep: `Page "${slug}" is now live with its Hero. Move on to section 2 immediately — three tool calls: (1) PAGE_PREVIEW_PROGRESS({ label: "Adding <next section>…" }) (2) Edit pages/${slug}/page.js to APPEND ONE new block (do not rewrite the whole array; one block per Edit, tight props) (3) PAGE_PREVIEW_REFRESH({}). Repeat for each remaining outline section. Target ~10s per section. DO NOT Read any file. DO NOT call ToolSearch. DO NOT use Write on page.js — only Edit. Each detour costs 5-15s the user watches "Working…" for. Stop at 5 sections unless the user asked for more.`,
    };
  },
});

export const PAGE_PREVIEW_REFRESH = defineTool({
  name: "PAGE_PREVIEW_REFRESH",
  description:
    "Reload the Page Editor iframe by incrementing the local preview refresh version.",
  annotations: {
    title: "Refresh Page Preview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: PagePreviewStatusOutputSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    const status = await refreshPagePreview(args);
    const slug = pageSlugFromStatus(status);
    const pageSlug = slug ?? "<slug>";
    return {
      ...status,
      nextStep: `Preview reloaded. If outline sections remain, your next three tool calls: PAGE_PREVIEW_PROGRESS({ label }) → Edit pages/${pageSlug}/page.js APPEND ONE block (tight props, max 3-4 items in any array, ≤1 short sentence per body) → PAGE_PREVIEW_REFRESH. DO NOT Read any file. DO NOT call ToolSearch. DO NOT use Write on page.js. DO NOT append more than one block per Edit. If you ALREADY built 5 sections (Nav, Hero, one supporting block, CTASection, Footer) or the outline is complete, the page is done — emit a one-sentence wrap-up to the user, that's it. Optional: if a single section (typically Hero or FAQ) looks visibly underweight, do ONE additional Edit on that block to add eyebrow / subtitle / answers / stats — at most one polish per build.`,
    };
  },
});

export const DESIGN_SYSTEM_CREATE = defineTool({
  name: "DESIGN_SYSTEM_CREATE",
  description:
    "Create a design system from a curated `template` slug (preferred) or freestyle brand tokens. The system prompt lists the available templates and when to pick each.",
  annotations: {
    title: "Create Design System",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string().describe("URL-safe slug (e.g. 'mise-violet')."),
    name: z.string().optional().describe("Display name."),
    template: z
      .string()
      .optional()
      .describe("Curated theme slug (preferred). See system prompt."),
    brand: BrandTokensInputSchema.describe(
      "Token overrides on top of `template` (partial OK), or full brand if no template.",
    ),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    const brand = { ...DEFAULT_BRAND, ...input.brand };
    if (input.name) brand.name = input.name;
    const result = await createDesignSystem({
      ...args,
      slug: input.slug,
      name: input.name,
      template: input.template,
      brand,
    });
    return {
      ok: true as const,
      slug: result.slug,
      nextStep: `DS "${result.slug}" ready. Next: PAGE_PREVIEW_PROGRESS({ label: "Setting up the page…" }) then PAGE_PREVIEW_PAGE_CREATE({ slug, designSystem: "${result.slug}" }).`,
    };
  },
});

export const DESIGN_SYSTEM_TEMPLATES_LIST = defineTool({
  name: "DESIGN_SYSTEM_TEMPLATES_LIST",
  description:
    "List the curated, contrast-checked theme templates available to DESIGN_SYSTEM_CREATE. Each entry has a slug, displayName, vibe (one-line aesthetic), and full brand-token preview. Pick one whose vibe matches the user's brief, pass its slug as `template` to DESIGN_SYSTEM_CREATE, and optionally override `primary` + `name` to brand-personalize. Way cheaper (and more aesthetically coherent) than freestyling twelve hex values.",
  annotations: {
    title: "List Theme Templates",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    templates: z.array(
      z.object({
        slug: z.string(),
        displayName: z.string(),
        vibe: z.string(),
        brand: BrandTokensOutputSchema.omit({
          onPrimary: true,
          onSecondary: true,
          onAccent: true,
        }),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    return {
      templates: DEFAULT_THEMES.map((t) => ({
        slug: t.slug,
        displayName: t.displayName,
        vibe: t.vibe,
        brand: t.brand,
      })),
    };
  },
});

export const DESIGN_SYSTEM_LIST = defineTool({
  name: "DESIGN_SYSTEM_LIST",
  description: "List all design systems available in the Page Editor.",
  annotations: {
    title: "List Design Systems",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ designSystems: z.array(DesignSystemEntrySchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    const designSystems = await listDesignSystems(args);
    return { designSystems };
  },
});

export const DESIGN_SYSTEM_SET = defineTool({
  name: "DESIGN_SYSTEM_SET",
  description:
    "Activate a design system in the preview pane (shows its demo page).",
  annotations: {
    title: "Set Active Design System",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string().describe("Design system slug to activate."),
  }),
  outputSchema: PagePreviewStatusOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    return setActiveDesignSystem({ ...args, slug: input.slug });
  },
});

export const PAGE_PREVIEW_PAGE_CREATE = defineTool({
  name: "PAGE_PREVIEW_PAGE_CREATE",
  description:
    "Scaffold a new page bound to a design system and activate it as the preview target. Sections are added afterward via PAGE_RENDER_BLOCK.",
  annotations: {
    title: "Create Page",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string().describe("URL-safe page slug (e.g. 'pricing')."),
    designSystem: z.string().describe("Design system slug to bind."),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    // Always activate. The pre-REPL flow kept the DS preview visible until
    // the agent shipped the first section to avoid showing a blank page —
    // but in the browser-as-REPL flow the iframe renders sections from
    // in-memory blocks the moment they arrive, so there's no blank-page
    // window. Activating here ensures status.activeKind="page" for the
    // whole build, so when the agent's turn ends the Studio intent ladder
    // resolves to "page" instead of falling back to "ds-demo" and wiping
    // the REPL-rendered blocks from the iframe.
    const result = await createPage({
      ...args,
      slug: input.slug,
      designSystem: input.designSystem,
      name: input.name,
      title: input.title,
      description: input.description,
      activate: true,
    });
    return {
      ok: true as const,
      slug: result.slug,
      nextStep: buildPageCreateNextStep({
        slug: result.slug,
        outline: result.status.outline ?? null,
      }),
    };
  },
});

/**
 * PAGE_BOOTSTRAP — single-call replacement for DESIGN_SYSTEM_CREATE +
 * PAGE_PREVIEW_PAGE_CREATE + first PAGE_PREVIEW_PROGRESS. In every build
 * the agent did all three back-to-back; combining them eliminates two
 * sequential round-trips (~1–2 s of stream overhead) and removes the
 * "pick a slug for the DS vs the page" cognitive overhead — the page
 * slug is the source of truth; the DS slug is derived as `<slug>-ds`.
 *
 * Internally: creates the DS from the template (+ optional brand
 * overrides), creates the page bound to it, activates the page, sets
 * the outline on shared state, and returns the same slim output as the
 * individual tools.
 *
 * The system prompt directs the agent to call this as its second tool
 * (after the initial PAGE_PREVIEW_PROGRESS that triggers the prelude
 * gallery). Studio's Progress label derivation auto-flips the pill to
 * "Bootstrapping <template>…" when this fires.
 */
export const PAGE_BOOTSTRAP = defineTool({
  name: "PAGE_BOOTSTRAP",
  description:
    "Set up the entire page in one call: create design system + create page + activate + declare outline. Replaces DESIGN_SYSTEM_CREATE + PAGE_PREVIEW_PAGE_CREATE.",
  annotations: {
    title: "Bootstrap Page",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z
      .string()
      .describe(
        "URL-safe page slug (e.g. 'funnel-ai'). The DS slug is derived as '<slug>-ds'.",
      ),
    template: z
      .string()
      .describe("Curated theme slug (see system prompt theme table)."),
    brand: BrandTokensInputSchema.optional().describe(
      "Optional token overrides on top of the template (e.g. { primary: '#XYZ' }).",
    ),
    outline: z
      .array(z.string().min(1).max(40))
      .min(2)
      .max(14)
      .describe(
        "Ordered section labels for the page, top to bottom (e.g. ['Nav','Hero','Features','CTA','Footer']). Nav MUST be first if present. Footer MUST be last if present. No duplicate section names.",
      ),
    name: z
      .string()
      .optional()
      .describe("Display name for the page (defaults to slug)."),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    // Validate outline structure BEFORE creating anything on disk. The
    // agent has gone rogue when these fail (Footer mid-list, dupe
    // sections after Footer, etc) — failing fast with a clear LLM-first
    // message means it self-corrects on the retry instead of producing
    // a broken page.
    const navIdxs = input.outline
      .map((s, i) => (/^nav$|^header$/i.test(s) ? i : -1))
      .filter((i) => i >= 0);
    if (navIdxs.length > 1) {
      throw new Error(
        `Outline has ${navIdxs.length} Nav/header entries. Use exactly one Nav, at index 0.`,
      );
    }
    if (navIdxs.length === 1 && navIdxs[0] !== 0) {
      throw new Error(
        `Outline has Nav at position ${navIdxs[0]} but it must be FIRST (position 0). Reorder: ['Nav', ...rest].`,
      );
    }
    const footerIdxs = input.outline
      .map((s, i) => (/^footer$/i.test(s) ? i : -1))
      .filter((i) => i >= 0);
    if (footerIdxs.length > 1) {
      throw new Error(
        `Outline has ${footerIdxs.length} Footer entries. Use exactly one Footer, at the last position.`,
      );
    }
    if (footerIdxs.length === 1 && footerIdxs[0] !== input.outline.length - 1) {
      throw new Error(
        `Outline has Footer at position ${footerIdxs[0]} but it must be LAST (position ${input.outline.length - 1}). Reorder so Footer is the final entry.`,
      );
    }
    const dupes = new Set<string>();
    const seen = new Set<string>();
    for (const s of input.outline) {
      if (seen.has(s)) dupes.add(s);
      seen.add(s);
    }
    if (dupes.size > 0) {
      throw new Error(
        `Outline has duplicate section(s): ${[...dupes].join(", ")}. A landing page can't have two of the same section — use unique names (e.g. FeatureGrid + Steps + StatStrip rather than FeatureGrid + FeatureGrid).`,
      );
    }
    const dsSlug = `${input.slug}-ds`;
    const brand = { ...DEFAULT_BRAND, ...(input.brand ?? {}) };
    if (input.name) brand.name = input.name;
    // 1. Design system. Seeded from the template, with any brand overrides
    //    layered on top.
    await createDesignSystem({
      ...args,
      slug: dsSlug,
      name: input.name,
      template: input.template,
      brand,
    });
    // 2. Outline. Recorded on shared state so the iframe stepper has the
    //    full plan before the first block lands.
    await setPageProgress({
      ...args,
      label: "Building the page…",
      outline: input.outline,
    });
    // 3. Page. Activated (status.activeKind="page") so the post-build
    //    intent ladder resolves to "page" — see PAGE_PREVIEW_PAGE_CREATE
    //    for the rationale on always-activate.
    const pageResult = await createPage({
      ...args,
      slug: input.slug,
      designSystem: dsSlug,
      name: input.name,
      activate: true,
    });
    const first = input.outline[0];
    return {
      ok: true as const,
      slug: pageResult.slug,
      nextStep: `Page "${pageResult.slug}" bootstrapped (DS "${dsSlug}", ${input.outline.length} sections). Ship 1/${input.outline.length}: PAGE_RENDER_BLOCK({ slug: "${pageResult.slug}", section: "${first}", props: {...} }). Follow each nextStep until COMPLETE.`,
    };
  },
});

export const PAGE_PREVIEW_PROGRESS = defineTool({
  name: "PAGE_PREVIEW_PROGRESS",
  description:
    "Show a short user-facing status label in the preview pane. Pass `outline` on the FIRST call of a build to populate the stepper; omit it on later calls.",
  annotations: {
    title: "Page Preview Progress",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    label: z
      .string()
      .min(1)
      .max(120)
      .describe("3–6 word imperative ending in '…' (e.g. 'Adding the hero…')."),
    outline: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(12)
      .optional()
      .describe("Ordered section labels for the stepper. First call only."),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    await setPageProgress({
      ...args,
      label: input.label,
      outline: input.outline ?? null,
    });
    return { ok: true as const };
  },
});

/* ---------------------------------------------------------------------------
 * Browser-as-REPL block tools — the fast section-authoring path.
 *
 * Each call mutates an in-memory block list on the server. Studio's preview
 * pane observes these tool calls in the chat stream and postMessages the
 * iframe directly (no /state refetch, no module re-import). An async
 * background write keeps `pages/<slug>/page.js` in sync for export and
 * tab-reload resilience — but the agent does NOT await it.
 *
 * The agent ships JSON props, not JS source code. That eliminates the
 * Edit/Read/Refresh roundtrips that dominate per-section latency in the
 * file-based flow.
 * ------------------------------------------------------------------------- */

const BlockPropsSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Section props object. Pass the prop names the chosen section template expects — see the AUTHORITATIVE prop contracts in the system prompt.",
  );

export const PAGE_RENDER_BLOCK = defineTool({
  name: "PAGE_RENDER_BLOCK",
  description:
    "Append one section to the active page. Sections render in call order, top to bottom (no position parameter). Section names + prop contracts are listed in the system prompt.",
  annotations: {
    title: "Render Page Block",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string().describe("Page slug from PAGE_PREVIEW_PAGE_CREATE."),
    section: z
      .string()
      .describe(
        "sections.js export name (see system prompt for the full list).",
      ),
    props: BlockPropsSchema,
  }),
  outputSchema: z.object({
    ok: z.literal(true),
    index: z.number().int().nonnegative(),
    nextStep: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    const result = await appendBlock({
      ...args,
      slug: input.slug,
      block: { section: input.section, props: input.props },
    });
    return {
      ok: true as const,
      index: result.index,
      nextStep: buildRenderBlockNextStep({
        justShipped: input.section,
        outline: result.outline,
        sectionsRendered: result.sectionsRendered,
      }),
    };
  },
});

/**
 * One-line nextStep for PAGE_PREVIEW_PAGE_CREATE.
 *
 * Hands the agent the FIRST outline entry by name plus a literal template
 * for the next two tool calls — that's the single biggest lever on shipping
 * the full outline. No embedded library reference (the system prompt is the
 * single source for prop contracts) and no enumeration of all declared
 * sections (they're shipped one at a time via buildRenderBlockNextStep).
 */
function buildPageCreateNextStep(args: {
  slug: string;
  outline: string[] | null;
}): string {
  const { slug, outline } = args;
  if (outline && outline.length > 0) {
    const first = outline[0];
    const total = outline.length;
    return `Page "${slug}" scaffolded. Ship 1/${total}: PAGE_PREVIEW_PROGRESS({ label: "Adding ${first}…" }) then PAGE_RENDER_BLOCK({ slug: "${slug}", section: "${first}", props: {...} }). Follow the nextStep on each response until COMPLETE.`;
  }
  return `Page "${slug}" scaffolded. Ship Nav first: PAGE_PREVIEW_PROGRESS({ label: "Adding the nav…" }) then PAGE_RENDER_BLOCK({ slug: "${slug}", section: "Nav", props: {...} }). Aim for 5+ sections (Nav, Hero, content, CTA, Footer).`;
}

/**
 * One-line nextStep for PAGE_RENDER_BLOCK.
 *
 * Load-bearing signals preserved: progress fraction, the explicit name of
 * the next section, and the literal COMPLETE marker (the agent's stop
 * condition). Everything else trimmed.
 */
function buildRenderBlockNextStep(args: {
  justShipped: string;
  outline: string[] | null;
  sectionsRendered: string[];
}): string {
  const { outline, sectionsRendered } = args;
  const shipped = sectionsRendered.length;
  if (outline && outline.length > 0) {
    const declared = outline.length;
    if (shipped >= declared) {
      return `Shipped ${shipped}/${declared}. Page COMPLETE — end your turn with ONE short line that names what was built AND ends with a question asking whether the user wants a review pass. Examples: "Your <topic> page is live. Want me to review it and propose 2–3 polish tweaks?" / "Shipped — should I take another pass and flag anything weak?". Do NOT call PAGE_REVIEW_SUGGEST yet; do NOT call PAGE_RENDER_BLOCK again. Wait for the user's answer.`;
    }
    const next = outline[shipped];
    return `Shipped ${shipped}/${declared}. Next: PAGE_PREVIEW_PROGRESS({ label: "Adding ${next}…" }) then PAGE_RENDER_BLOCK({ section: "${next}", props: {...} }).`;
  }
  if (shipped < 4) {
    return `Shipped ${shipped}. Keep going — a landing page needs at least Nav, Hero, content, CTA, Footer.`;
  }
  return `Shipped ${shipped}. End your turn unless more sections are needed.`;
}

export const PAGE_UPDATE_BLOCK = defineTool({
  name: "PAGE_UPDATE_BLOCK",
  description:
    "Patch one section's props in place (shallow-merge by default). Polish path; usually skip during initial build.",
  annotations: {
    title: "Update Page Block",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string(),
    index: z
      .number()
      .int()
      .nonnegative()
      .describe("Index returned from the original PAGE_RENDER_BLOCK."),
    props: BlockPropsSchema,
    replace: z
      .boolean()
      .optional()
      .describe("Replace props entirely instead of merging. Default false."),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    await updateBlock({
      ...args,
      slug: input.slug,
      index: input.index,
      propsPatch: input.props,
      replace: input.replace,
    });
    return { ok: true as const };
  },
});

export const PAGE_REMOVE_BLOCK = defineTool({
  name: "PAGE_REMOVE_BLOCK",
  description: "Remove one section by index. Remaining blocks shift left.",
  annotations: {
    title: "Remove Page Block",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string(),
    index: z.number().int().nonnegative(),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    await removeBlock({
      ...args,
      slug: input.slug,
      index: input.index,
    });
    return { ok: true as const };
  },
});

/**
 * PAGE_REVIEW_SUGGEST — emit one critique tooltip during the review pass.
 *
 * After the agent ships all sections, it calls this tool 2–3 times (one
 * per suggestion) instead of writing prose in chat. Studio observes
 * these calls in the chat stream and renders each as a floating tooltip
 * over the matching section in the preview iframe. Each tooltip has
 * Accept / Dismiss buttons; Accept fills the chat input with the
 * suggestion's `prompt` and auto-submits — the user goes from "see a
 * suggestion" to "ship the fix" in one click.
 *
 * Server-side this tool is a marker: it doesn't mutate disk state. The
 * payload is what Studio walks the stream for.
 */
export const PAGE_REVIEW_SUGGEST = defineTool({
  name: "PAGE_REVIEW_SUGGEST",
  description:
    "Emit ONE review tip pinned to a section in the preview. The user sees it as a floating tooltip; clicking Accept sends `prompt` back as their next message. Call 2–3 times during the review pass (parallel is fine).",
  annotations: {
    title: "Suggest Review Tip",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    section: z
      .string()
      .describe(
        "Section name this suggestion is about (Nav, Hero, Features, etc). Used to anchor the tooltip to the right block.",
      ),
    prompt: z
      .string()
      .min(8)
      .max(300)
      .describe(
        "The suggestion as a user-facing prompt — ONE sentence the user could literally send back to you to enact the change. Name the section + the specific change. Example: 'Tighten the Hero subtitle to a concrete outcome metric instead of generic copy.'",
      ),
  }),
  outputSchema: PagePreviewSlimOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    // No persistence — the tool call itself is the artifact (Studio
    // walks the stream).
    return {
      ok: true as const,
      nextStep: `Tip for "${input.section}" registered. Continue with more PAGE_REVIEW_SUGGEST calls (max 3 total) or end your turn with NO text.`,
    };
  },
});

export const PAGE_GET_BLOCKS = defineTool({
  name: "PAGE_GET_BLOCKS",
  description:
    "Return the current block list for a page (live, in-memory). Use sparingly — the agent usually does not need to inspect state, it tracks indices from its own PAGE_RENDER_BLOCK responses.",
  annotations: {
    title: "Get Page Blocks",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z.string().describe("Page slug."),
  }),
  outputSchema: z.object({
    blocks: z.array(
      z.object({
        section: z.string(),
        props: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const args = orgArgs(ctx);
    await ctx.access.check();
    const blocks = getBlocks({ ...args, slug: input.slug });
    return { blocks };
  },
});
