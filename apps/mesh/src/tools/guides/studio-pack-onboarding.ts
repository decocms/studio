import type { GuidePrompt } from "./index";

/**
 * MCP prompts that back the home-page "next actions" cards. Each prompt
 * corresponds to a Studio Pack checklist item; the agent's `selected_prompts`
 * whitelists only its own entries so a `/promptName` mention in chat shows
 * the relevant set per agent.
 *
 * The text body is what gets autosent as the first user message when the
 * user clicks the corresponding home card. For items that today have no
 * autosend prompt (the agent's welcome message did the work), we author a
 * short trigger sentence and rely on the agent's instructions to drive the
 * conversation.
 */
export const prompts: GuidePrompt[] = [
  // Brand Manager
  {
    name: "brand-manager-set-up",
    title: "Set up your brand",
    description:
      "Create your brand context — extract from a domain or set up manually.",
    text: "Help me set up my brand context. Start by asking for my website URL so you can extract logo, colors, fonts, and overview automatically — or guide me through manual setup if I don't have a public site.",
  },
  {
    name: "brand-manager-complete-profile",
    title: "Complete your brand profile",
    description: "Fill in logo, colors, and fonts on your existing brand.",
    text: "Help me fill in the rest of my brand profile — logo, colors, and fonts. Check what's already there and ask me about the missing pieces.",
  },
  {
    name: "brand-manager-create-landing-page",
    title: "Create a landing page",
    description:
      "Author a brand-aligned landing page using your active brand context.",
    text: "Build me a landing page now using my brand. I'll iterate after I see it.",
  },
  // Store Manager
  {
    name: "store-manager-browse-store",
    title: "Browse the Deco Store",
    description:
      "Explore what's in the Store and Community Registry and get MCP recommendations.",
    text: "Show me what's in the Deco Store and the Community Registry. Ask me what problem I'm trying to solve and recommend a few MCPs that fit.",
  },
];
