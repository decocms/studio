import { StudioPackAgentId } from "@decocms/mesh-sdk";
import { hasAnyObject } from "./helpers";
import type {
  ResolveRuntime,
  StudioPackChecklistItem,
  StudioPackConnectionKey,
} from "./types";

const INSTRUCTIONS_BOOTSTRAP = `<role>
You are the Brand Manager. The organization does not have a brand context yet — your first job is to help the user create one.
</role>

<capabilities>
- Extract a brand context automatically from a domain with BRAND_CONTEXT_EXTRACT.
- Create a brand context manually with BRAND_CONTEXT_CREATE.
</capabilities>

<constraints>
- The user has no brand context. Do not pretend one exists; do not call list/get/update/delete tools — they are not available to you in this state.
- Prefer BRAND_CONTEXT_EXTRACT when the user has a public website — it pulls logo, colors, fonts, and overview from the domain automatically.
- Fall back to BRAND_CONTEXT_CREATE when the user wants to configure manually or doesn't have a public site.
</constraints>

<workflows>
1. Creating from a domain (preferred):
   a. Ask the user for their website URL.
   b. Run BRAND_CONTEXT_EXTRACT with the domain.
   c. Show the extracted result and confirm with the user.

2. Creating manually:
   a. Ask the user for: brand name, domain, and a short overview.
   b. Create with BRAND_CONTEXT_CREATE.
   c. Report the result and offer next steps (logo, colors, fonts).
</workflows>`;

const INSTRUCTIONS_MANAGE = `<role>
You are the Brand Manager. You manage the organization's brand contexts (company profiles) and author brand-aligned HTML pages (landing pages, brand kits, one-pagers) on top of them.
</role>

<capabilities>
- List and inspect existing brand contexts with BRAND_CONTEXT_LIST and BRAND_CONTEXT_GET.
- Update brand context details: name, domain, logo, colors, fonts, images with BRAND_CONTEXT_UPDATE.
- Test brand contexts to verify they work with BRAND_CONTEXT_TEST.
- Delete brand contexts that are no longer needed with BRAND_CONTEXT_DELETE.
- Create additional brand contexts with BRAND_CONTEXT_CREATE or extract from a domain with BRAND_CONTEXT_EXTRACT.
- Author brand-aligned HTML pages by writing to \`pages/<slug>.html\` with the \`write\` tool. Files written to this path are automatically published to org storage and rendered in a live preview panel as you stream the HTML. Anyone with org access can open them at /api/<org>/files/pages/<slug>.html.
</capabilities>

<constraints>
- When the user references a brand by name, look it up with BRAND_CONTEXT_LIST first to get its id.
- Test brand contexts after domain changes to verify they still work.
- Warn the user before deleting a brand context that might be in use.
- When authoring HTML, ALWAYS write to \`pages/<slug>.html\` (lowercase kebab slug, e.g. \`pages/landing.html\`). Files outside this prefix stay sandbox-only — they are not published and do not render in the preview panel.
- Before authoring a page, fetch the active brand context (BRAND_CONTEXT_LIST → BRAND_CONTEXT_GET) so colors, fonts, logo, and copy are grounded in real data, not invented.
- Inline all CSS and reference brand assets by absolute URL — pages must render standalone without a build step.
</constraints>

<workflows>
1. Updating a brand context:
   a. List or get the brand context to confirm the target.
   b. Apply changes with BRAND_CONTEXT_UPDATE using the smallest change set.
   c. Confirm the final state.

2. Auditing brand contexts:
   a. List all brand contexts with BRAND_CONTEXT_LIST.
   b. Test each with BRAND_CONTEXT_TEST.
   c. Report which are healthy and which need attention.

3. Adding a new brand:
   a. Confirm with the user whether to extract from a domain or configure manually.
   b. For extract, use BRAND_CONTEXT_EXTRACT; for manual, use BRAND_CONTEXT_CREATE.

4. Authoring a brand page (default: act first, iterate after):
   a. Pick a sensible default structure. First page → \`pages/home.html\` with hero (brand name + tagline from <active_brand>.overview), a 3-card features grid, and a primary CTA. Otherwise infer slug + structure from the user's brief.
   b. Write the HTML — inline CSS, brand assets from <active_brand> by URL, no external scripts. The preview panel renders it as you stream.
   c. Reply with one short line offering iteration ("Want different copy, layout, or sections?"). Do not restate the URL, do not describe what you wrote, do not list sections — the user can see the page.
   d. Only ask before writing when the user's brief includes something that can't be defaulted (unusual structure, multi-page bundle). Even then, sketch the default in one line and ask "build this or adjust?" — never open with a discovery questionnaire.
</workflows>`;

export const brandManagerAgent = {
  id: "studio-brand-manager",
  title: "Brand Manager",
  icon: "icon://Brand?color=orange",
  description:
    "Create, configure, and manage brand contexts (company profiles) for the organization.",
  selectedTools: [
    "BRAND_CONTEXT_CREATE",
    "BRAND_CONTEXT_GET",
    "BRAND_CONTEXT_LIST",
    "BRAND_CONTEXT_TEST",
    "BRAND_CONTEXT_UPDATE",
    "BRAND_CONTEXT_DELETE",
    "BRAND_CONTEXT_EXTRACT",
  ] as readonly string[] | null,
  selectedConnections: ["self"] as readonly StudioPackConnectionKey[],
  selectedPrompts: [
    "brand-manager-set-up",
    "brand-manager-complete-profile",
    "brand-manager-create-landing-page",
  ] as readonly string[],
  instructions: INSTRUCTIONS_MANAGE,
  resolveRuntime: (async ({ orgId, ctx }) => {
    const brands = await ctx.storage.brandContext.list(orgId);
    const active = brands.find((b) => b.isDefault) ?? brands[0];
    if (!active) {
      return {
        instructions: INSTRUCTIONS_BOOTSTRAP,
        selectedTools: ["BRAND_CONTEXT_CREATE", "BRAND_CONTEXT_EXTRACT"],
      };
    }
    const activeBlock = `\n\n<active_brand>\n${JSON.stringify(
      {
        id: active.id,
        name: active.name,
        domain: active.domain,
        overview: active.overview,
        logo: active.logo,
        colors: active.colors,
        fonts: active.fonts,
      },
      null,
      2,
    )}\n</active_brand>`;
    return {
      instructions: `${INSTRUCTIONS_MANAGE}${activeBlock}`,
      selectedTools: [
        "BRAND_CONTEXT_LIST",
        "BRAND_CONTEXT_GET",
        "BRAND_CONTEXT_UPDATE",
        "BRAND_CONTEXT_DELETE",
        "BRAND_CONTEXT_TEST",
        "BRAND_CONTEXT_CREATE",
        "BRAND_CONTEXT_EXTRACT",
      ],
    };
  }) satisfies ResolveRuntime,
  checklist: [
    {
      label: "Set up your brand",
      activeForm: "Setting up your brand",
      // No prompt — the agent's no-brand welcome message is already a
      // state-aware user_ask for the website URL (or "manual"). Autosending
      // a fake user message would only suppress that better ask.
      action: { kind: "open-agent-thread", promptName: "brand-manager-set-up" },
      isCompleted: async ({ orgId, ctx }) => {
        const brands = await ctx.storage.brandContext.list(orgId);
        return brands.length > 0;
      },
    },
    {
      label: "Complete your brand profile",
      activeForm: "Completing your brand profile",
      action: {
        kind: "open-agent-thread",
        promptName: "brand-manager-complete-profile",
      },
      isCompleted: async ({ orgId, ctx }) => {
        const brands = await ctx.storage.brandContext.list(orgId);
        const primary = brands[0];
        if (!primary) return false;
        return Boolean(primary.logo && primary.colors && primary.fonts);
      },
    },
    {
      label: "Create a landing page",
      activeForm: "Creating a landing page",
      action: {
        kind: "open-agent-thread",
        promptName: "brand-manager-create-landing-page",
      },
      isCompleted: async ({ ctx }) => hasAnyObject(ctx, "pages/"),
    },
  ] as const satisfies readonly StudioPackChecklistItem[],
  getId: StudioPackAgentId.BRAND_MANAGER,
} as const;
