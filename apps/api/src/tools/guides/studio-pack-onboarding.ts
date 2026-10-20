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
        ? `I want to ${goal}. What tools in the Deco registry can help?`
        : "Show me what's in the Deco Store. Recommend a few tools that fit common business needs.";
    },
  },
];
