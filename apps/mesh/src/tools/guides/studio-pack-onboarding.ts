import type { GuidePrompt } from "./index";

/**
 * MCP prompts that back the home-page "next actions" cards. Each prompt
 * corresponds to a Studio Pack checklist item; the agent's `selected_prompts`
 * whitelists only its own entries so a `/promptName` mention in chat shows
 * the relevant set per agent.
 *
 * The text body is what gets autosent as the first user message when the
 * user clicks the corresponding home card. Wording is intentionally short
 * and business-friendly — the agent's instructions decide which tools to
 * call based on whether an optional argument was supplied.
 */
export const prompts: GuidePrompt[] = [
  // Brand Manager
  {
    name: "brand-manager-set-up",
    title: "Set up your brand",
    description: "Add your brand so pages, emails, and assets stay on-brand.",
    arguments: [
      {
        name: "website",
        description:
          "https://your-site.com — we'll grab your logo, colors, and fonts",
        required: false,
      },
    ],
    text: ({ website }) => {
      const url = website?.trim();
      return url
        ? `Set up my brand from ${url}.`
        : "Help me set up my brand. I don't have a public site yet.";
    },
  },
  {
    name: "brand-manager-complete-profile",
    title: "Complete your brand profile",
    description: "Add the missing pieces — logo, colors, and fonts.",
    text: "What's missing from my brand profile? Help me fill it in.",
  },
  {
    name: "brand-manager-create-landing-page",
    title: "Create a landing page",
    description: "Build a landing page that uses your brand.",
    arguments: [
      {
        name: "goal",
        description:
          "What's the page for? (e.g. product launch, newsletter signup)",
        required: false,
      },
    ],
    text: ({ goal }) => {
      const purpose = goal?.trim();
      return purpose
        ? `Build me a landing page for: ${purpose}.`
        : "Build me a landing page using my brand. I'll iterate after I see it.";
    },
  },
  // Store Manager
  {
    name: "store-manager-browse-store",
    title: "Browse the Deco Store",
    description: "See what's available and get recommendations for your team.",
    arguments: [
      {
        name: "problem",
        description:
          "What are you trying to solve? (e.g. send invoices, sync support tickets)",
        required: false,
      },
    ],
    text: ({ problem }) => {
      const goal = problem?.trim();
      return goal
        ? `I want to ${goal}. What tools in the Deco Store and Community Registry can help?`
        : "Show me what's in the Deco Store. Recommend a few tools that fit common business needs.";
    },
  },
];
