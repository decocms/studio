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

import {
  getBrandContextSetupId,
  getWellKnownDecopilotVirtualMCP,
} from "@decocms/mesh-sdk";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import type { PresetTaskDefinition } from "./index";

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
    action: { kind: "preset", tileType: "studio.brand-context" },
    // Hide once the org has any brand_context row — the next time the
    // user lands on home the card disappears, which is the visual
    // confirmation the LLM finished extraction successfully.
    isApplicable: async (ctx, _state, mesh) => {
      const existing = await mesh.storage.brandContext.getDefault(
        ctx.organizationId,
      );
      return !existing;
    },
    start: async (ctx, mesh) => {
      const orgName = mesh.organization?.name ?? "my organization";
      const userName = mesh.auth.user?.name;
      const greeting = userName ? `Hey, I'm ${userName}. ` : "";
      // Lightweight seed — the brand-context-setup virtual MCP carries
      // the system prompt (in `metadata.instructions`) and dispatchRun
      // injects the matching built-in tool by agent id. Both survive
      // across every turn of this thread.
      const text = `${greeting}Let's set up the brand context for my organization ${orgName}.`;
      return {
        messages: [userMessage(text)],
        virtualMcpId: getBrandContextSetupId(ctx.organizationId),
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
    action: { kind: "preset", tileType: "studio.landing-page" },
    isApplicable: () => true,
    start: async (ctx) => {
      const text =
        "Draft a landing page for my product using my existing brand. Start " +
        "with a hero, three feature sections, social proof, and a CTA.";
      return {
        messages: [userMessage(text)],
        virtualMcpId: getWellKnownDecopilotVirtualMCP(ctx.organizationId).id,
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
    action: { kind: "preset", tileType: "studio.error-monitoring" },
    isApplicable: () => true,
    start: async (ctx) => {
      const text =
        "Help me set up error monitoring for my app. Walk me through " +
        "connecting the stack and start capturing errors.";
      return {
        messages: [userMessage(text)],
        virtualMcpId: getWellKnownDecopilotVirtualMCP(ctx.organizationId).id,
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
];
