import type { Elenchus } from "@decocms/telos/elenchus";
import type { OnboardingTarget } from "./target";

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
]);

// MOCK research. The maieutic: "question/research" the user from their email and
// birth a candidate goal. Swap this body for a real Firecrawl/Perplexity/Exa
// call later — the Elenchus contract (deliver → GoalProposal) stays the same.
export function researchElenchus(email: string): Elenchus<OnboardingTarget> {
  return {
    async deliver(_tenant) {
      const domain = (email.split("@")[1] ?? "").toLowerCase();
      const isCompany = domain.length > 0 && !PERSONAL_DOMAINS.has(domain);

      const target: OnboardingTarget = isCompany
        ? {
            title: `Connect ${domain}'s core tools and run a first automation`,
            metric: "connections",
            targetValue: 3,
          }
        : {
            title: "Connect your first tool and run an automation",
            metric: "connections",
            targetValue: 1,
          };

      const rationale = isCompany
        ? `Company domain "${domain}" → likely a team evaluating Mesh; aim for a small multi-tool activation.`
        : `Personal domain "${domain || "unknown"}" → likely an individual; aim for first-tool activation.`;

      return {
        target,
        rationale,
        citations: [
          { url: `https://${domain || "example.com"}`, title: domain },
        ],
      };
    },
  };
}
