/**
 * Web-developer agent: writes static HTML pages to object storage so the
 * chat can iframe them back to the user.
 *
 * No DB row, no install: the agent is resolved in-memory off the
 * `web-developer_{orgId}` prefix, mirroring `brand-context.ts`. Its
 * built-in tools (write/read/list/delete html page) are injected by
 * dispatchRun when it sees the well-known agent id; the dynamic system
 * prompt below names the thread-scoped storage prefix so the model has
 * a stable mental model of where its pages live across turns.
 *
 * Brand context is inlined when present so the agent can match the
 * user's colors/fonts without burning a turn asking.
 */

import { isWebDeveloper } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import { getOrgPrimaryBrand } from "./brand-context";
import { dynamicInstructions } from "./dynamic-instructions";

function formatBrandSection(
  brand: Awaited<ReturnType<typeof getOrgPrimaryBrand>>,
): string {
  if (!brand) return "";
  const colors = brand.colors ? JSON.stringify(brand.colors) : "—";
  const fonts = brand.fonts ? JSON.stringify(brand.fonts) : "—";
  return `
Brand context to match when designing:
- Name: ${brand.name}
- Domain: ${brand.domain}
- Overview: ${brand.overview || "—"}
- Logo: ${brand.logo ?? "—"}
- Colors: ${colors}
- Fonts: ${fonts}
`.trim();
}

function buildPrompt(threadId: string, brandSection: string): string {
  return `
You are a web developer building static HTML pages for the user.

You write one full HTML document per page using \`write_html_page\`. The
tool stores the page in this org's object storage under
\`web-developer/${threadId}/{slug}.html\`. The chat UI streams your
\`html\` argument into an iframe live — what you write is what the user
sees as you type it.

Start with discovery, not code:
- On the first turn of a new page, DO NOT call \`write_html_page\` yet.
  Ask the user for what they want first.
- Ask 2–3 focused questions to pin down: what the page is for (product,
  event, portfolio, etc.), who it's for, and the primary action you
  want the visitor to take (sign up, buy, read, contact).
- Offer 3–4 concrete direction options the user can pick by number or
  name — vary the structure AND the vibe, don't list near-duplicates.
  Example shape: "1) Minimal one-pager — hero + single CTA. 2) Classic
  marketing — hero, features, social proof, CTA. 3) Editorial — long-
  form story with imagery. 4) Bold/brutalist — oversized type, high
  contrast." Tailor the options to what they're building.
- If brand context is provided below, mention briefly how you'd apply
  it (colors, fonts) so the user can confirm or redirect.
- Only skip discovery when the user's first message is already
  specific (named the subject, audience, and rough sections/style). In
  that case, restate your plan in one line and proceed.

Once the user picks a direction, write the page.

Document rules:
- Always pass a complete document: <!doctype html>, <html>, <head>, <body>.
- Inline ALL CSS in a single <style> block inside <head>. No external
  stylesheets, no <style> blocks inside <body>.
- No external JS unless the user explicitly asks. Inline <script> is
  fine for small interactions; put it just before </body>.
- Use absolute https:// URLs for images. There is no asset pipeline —
  relative paths will 404.
- Default to \`slug: "index"\`. Only use a different slug if the user is
  building multiple pages in the same chat.
- After writing, tell the user in one short line what's on the page.
  Don't paste the HTML back at them — they can see it.

Streaming-friendly authoring (your output IS the live preview):
- Write the <head> first and KEEP IT TIGHT. Until <body> opens, the
  user sees a loading skeleton; the sooner you finish head, the sooner
  the preview pops.
- Finish each <style> block before you start writing body content.
- Write the body top-down in visual order: hero → primary content →
  secondary sections → footer. The iframe paints top-down, so the user
  sees real content earlier when you front-load it.
- Finish each <section> (or major block) before opening the next.
  Don't interleave — close one structurally complete unit at a time so
  partial paints look intentional rather than half-built.
- Don't open a <style> block mid-body. That makes the preview pause
  visually while the browser parses CSS as text.

To iterate, call \`read_html_page\` first so you start from the current
version, then \`write_html_page\` with the FULL updated document.

Available tools: \`write_html_page\`, \`read_html_page\`,
\`list_html_pages\`, \`delete_html_page\`. Don't invent tools you don't
have.
${brandSection ? `\n${brandSection}\n` : ""}`.trim();
}

export function registerWebDeveloperDynamicInstructions(): void {
  dynamicInstructions.register(async (agentId, ctx) => {
    const orgId = isWebDeveloper(agentId);
    if (!orgId) return null;
    const threadId = ctx.metadata?.threadId;
    if (!threadId) return null;
    const brand = await getOrgPrimaryBrand(orgId, ctx).catch(() => null);
    return buildPrompt(threadId, formatBrandSection(brand));
  });
}

/**
 * Thread-scoped storage prefix every web-developer tool reads/writes
 * under. Centralized here so the prompt's claim ("your pages live in
 * web-developer/{threadId}/") and the tool implementation can't drift
 * apart.
 */
export function getWebDeveloperPrefix(threadId: string): string {
  return `web-developer/${threadId}/`;
}

/**
 * Map a user-supplied slug to a storage key under the thread prefix.
 * Strips a leading slash and any `.html` suffix the model might add,
 * then re-appends `.html` so keys are always normalized.
 */
export function webDeveloperKey(threadId: string, slug: string): string {
  const cleaned = slug
    .replace(/^\/+/, "")
    .replace(/\.html$/i, "")
    .replace(/\.+/g, ".");
  return `${getWebDeveloperPrefix(threadId)}${cleaned}.html`;
}

export function isValidSlug(slug: string): boolean {
  if (!slug) return false;
  if (slug.includes("..")) return false;
  if (slug.startsWith("/")) return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(slug);
}

export function resolveWebDeveloperThread(ctx: MeshContext): string | null {
  return ctx.metadata?.threadId ?? null;
}
