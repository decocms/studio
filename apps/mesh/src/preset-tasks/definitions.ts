/**
 * Built-in preset task definitions.
 *
 * The single source of truth for which preset cards exist, what they look
 * like, what happens on click, and (for `kind: "preset"`) the seed messages
 * that prime the agent thread. The FE renders whatever this registry
 * surfaces — no hardcoded card metadata or prompts on the client.
 *
 * All predicates currently return true. Tighten as concrete signals land —
 * e.g. `brand-context` only-if-no-brand-context-yet, `import-deco` only-for
 * users coming from a Deco-managed source.
 */

import { getBrandContextSetupId, getWebDeveloperId } from "@decocms/mesh-sdk";
import { getOrgPrimaryBrand } from "@/agents/brand-context";
import {
  ensureSystemHealthAgent,
  hasAuthenticatedSystemHealth,
} from "@/agents/system-health";
import { hasUserDecoCxSites } from "@/api/routes/deco-sites";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import type { MeshContext } from "@/core/mesh-context";
import { hasGithubInstallationOn } from "@/tools/github/has-installation";
import type { PresetTaskContext, PresetTaskDefinition } from "./index";

/** GitHub org that owns deco.cx site repos — gates the error-monitoring card. */
const DECO_SITES_GITHUB_LOGIN = "deco-sites";

/**
 * Whether the org has any access path the system-health agent can use:
 * a GitHub connection installed on github.com/deco-sites, or a signed-in
 * deco.cx user with at least one site under that email.
 */
async function hasMonitoringAccess(
  ctx: PresetTaskContext,
  mesh: MeshContext,
): Promise<boolean> {
  const { items: githubConns } = await mesh.storage.connections.list(
    ctx.organizationId,
    { slug: "mcp-github", includeVirtual: false },
  );
  for (const conn of githubConns) {
    if (await hasGithubInstallationOn(conn.id, DECO_SITES_GITHUB_LOGIN, mesh)) {
      return true;
    }
  }
  const email = resolveDecoCxEmail(mesh);
  if (email && (await hasUserDecoCxSites(email))) return true;
  return false;
}

/**
 * Pick the email used to probe deco.cx Supabase profiles.
 *
 * In local dev Better Auth signs the user in with a synthetic
 * `@localhost.mesh` placeholder that never matches a real deco.cx
 * profile, so we substitute a hardcoded dev email. In production the
 * primary auth email is the real one (OAuth-captured) and is used as-is.
 *
 * TODO: replace the hardcoded dev override with a settings field or a
 * Better Auth account-linking probe once we have a real story for dev
 * impersonation.
 */
function resolveDecoCxEmail(mesh: MeshContext): string | null {
  const email = mesh.auth.user?.email;
  if (!email) return null;
  if (email.endsWith("@localhost.mesh")) return "pedrofrxncx@deco.cx";
  return email;
}

/**
 * Build a seed user message for a preset start.
 */
function userMessage(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  } as ChatMessage;
}

export const PRESET_TASK_DEFINITIONS: PresetTaskDefinition[] = [
  {
    id: "new-chat",
    display: {
      title: "New chat",
      thumb: "/home/task-new-chat.svg",
      step: null,
    },
    action: { kind: "new-chat" },
    isApplicable: () => true,
    dismissible: false,
  },
  {
    id: "brand-context",
    display: {
      title: "Extract brand context",
      thumb: "/home/task-brand.svg",
      step: 1,
    },
    action: { kind: "preset" },
    // The brand-context agent has two modes — setup and confirm —
    // and the card stays visible across both. `resolve()` below swaps
    // the display + seed message when a brand_context row exists; the
    // agent itself flips its system prompt and toolset off the same
    // signal (see apps/mesh/src/agents/brand-context.ts).
    isApplicable: () => true,
    start: async (ctx, mesh) => {
      const orgName = mesh.organization?.name ?? "my organization";
      const userName = mesh.auth.user?.name;
      const greeting = userName ? `Hey, I'm ${userName}. ` : "";
      const text = `${greeting}Let's set up the brand context for my organization ${orgName}.`;
      return {
        messages: [userMessage(text)],
        virtualMcpId: getBrandContextSetupId(ctx.organizationId),
      };
    },
    resolve: async (ctx, _state, mesh) => {
      const brand = await getOrgPrimaryBrand(ctx.organizationId, mesh);
      if (!brand) return {};
      return {
        display: {
          title: "Confirm your brand",
          thumb: "/home/task-brand.svg",
          step: 1,
        },
        start: async (ctx) => ({
          messages: [
            userMessage(
              "Show me my brand context and let me confirm or adjust it.",
            ),
          ],
          virtualMcpId: getBrandContextSetupId(ctx.organizationId),
        }),
      };
    },
  },
  {
    id: "landing-page",
    display: {
      title: "Create landing page",
      thumb: "/home/task-landing.svg",
      step: 2,
    },
    action: { kind: "preset" },
    isApplicable: () => true,
    start: async (ctx) => {
      const text =
        "Draft a landing page for my product using my existing brand. Start " +
        "with a hero, three feature sections, social proof, and a CTA.";
      return {
        messages: [userMessage(text)],
        virtualMcpId: getWebDeveloperId(ctx.organizationId),
      };
    },
  },
  {
    id: "error-monitoring",
    display: {
      title: "Set up error monitoring",
      thumb: "/home/task-monitoring.svg",
      step: 3,
    },
    action: { kind: "preset" },
    isApplicable: (ctx, _state, mesh) => hasMonitoringAccess(ctx, mesh),
    resolve: async (ctx, _state, mesh) => {
      // System-health requires its own OAuth handshake on first use. Surface
      // an install action so the FE opens the dedicated dialog. Once the
      // org has an authenticated connection we fall through to the default
      // preset action.
      const authenticated = await hasAuthenticatedSystemHealth(
        ctx.organizationId,
        mesh,
      );
      if (!authenticated) {
        return { action: { kind: "install-system-health" } };
      }
      return {};
    },
    start: async (ctx, mesh) => {
      const userId = mesh.auth.user?.id;
      if (!userId) {
        throw new Error("Authenticated user required to install system health");
      }
      const virtualMcpId = await ensureSystemHealthAgent(
        ctx.organizationId,
        userId,
        mesh,
      );
      const text =
        "Show me the current health of my sites and walk me through fixing " +
        "the top errors.";
      return {
        messages: [userMessage(text)],
        virtualMcpId,
      };
    },
  },
  {
    id: "import-deco",
    display: {
      title: "Import Deco site",
      thumb: "/home/task-import-deco.svg",
      step: null,
    },
    action: { kind: "import-deco" },
    isApplicable: () => true,
  },
  {
    id: "install-github",
    display: {
      title: "Install GitHub",
      thumb: "/connections/github.png",
      step: null,
    },
    action: { kind: "install-github" },
    isApplicable: async (ctx, _state, mesh) => {
      const { items: githubConns } = await mesh.storage.connections.list(
        ctx.organizationId,
        { slug: "mcp-github", includeVirtual: false },
      );
      return githubConns.length === 0;
    },
  },
];
