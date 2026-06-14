import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { FactInput } from "@decocms/telos/postgres";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { OnboardingTarget } from "./target";

// From an email: scrape the domain (Firecrawl), web-search the person
// (Perplexity via OpenRouter), then synthesize tentative facts + a candidate goal.

export interface ResearchResult {
  facts: FactInput[];
  target: OnboardingTarget;
  rationale: string;
}

// Mocked research subject — no real signup data yet. Override with TELOS_RESEARCH_EMAIL.
export const RESEARCH_EMAIL =
  process.env.TELOS_RESEARCH_EMAIL ?? "pedrofrxncx@deco.cx";

const RESEARCH_MODEL = process.env.TELOS_RESEARCH_MODEL ?? "perplexity/sonar";
const SYNTH_MODEL = process.env.TELOS_SYNTH_MODEL ?? "openai/gpt-4o-mini";

const Synthesis = z.object({
  facts: z
    .array(
      z.object({
        label: z.string().describe("short noun, e.g. 'Company' or 'Role'"),
        value: z.string().describe("the finding, one concise sentence"),
        confidence: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(6)
    .describe("tentative facts about the person; the user will confirm these"),
  goal: z.object({
    title: z.string().describe("a concrete first goal phrased for the user"),
    metric: z.enum(["connections", "automations_run"]),
    targetValue: z.number().int().positive(),
    rationale: z.string().describe("why this goal fits what we found"),
  }),
});

// Best-effort: returns "" if the key is missing or the scrape fails.
async function scrapeDomain(domain: string): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key || !domain) return "";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        url: `https://${domain}`,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.warn(`[telos] firecrawl ${domain} → ${res.status}`);
      return "";
    }
    const json = (await res.json()) as {
      data?: { markdown?: string };
    };
    return (json.data?.markdown ?? "").slice(0, 8_000);
  } catch (err) {
    console.warn("[telos] firecrawl failed", err);
    return "";
  }
}

export async function researchUser(email: string): Promise<ResearchResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const openrouter = createOpenRouter({ apiKey });

  const domain = (email.split("@")[1] ?? "").toLowerCase();

  const [site, dossier] = await Promise.all([
    scrapeDomain(domain),
    generateText({
      model: openrouter(RESEARCH_MODEL),
      prompt:
        `Research the person behind the email "${email}". Focus on: who they ` +
        `likely are, what the company at "${domain}" does, their industry, ` +
        `team size, and what tools/integrations such a team typically uses. ` +
        `Be concise and cite what you find.`,
    }).then(
      (r) => r.text,
      (err) => {
        console.warn("[telos] perplexity research failed", err);
        return "";
      },
    ),
  ]);

  const { object } = await generateObject({
    model: openrouter(SYNTH_MODEL),
    schema: Synthesis,
    prompt:
      `You are onboarding a new user of an MCP control plane (they connect ` +
      `tools and run automations). From the research below, extract up to 6 ` +
      `tentative facts about the user and propose ONE concrete first goal ` +
      `measured by either "connections" (tools connected) or "automations_run". ` +
      `Prefer 1 connection for an individual, 3 for a team.\n\n` +
      `EMAIL: ${email}\nDOMAIN: ${domain}\n\n` +
      `WEB RESEARCH:\n${dossier || "(none)"}\n\n` +
      `DOMAIN WEBSITE:\n${site || "(none)"}`,
  });

  return {
    facts: object.facts.map((f) => ({
      ...f,
      sourceUrl: domain ? `https://${domain}` : undefined,
    })),
    target: {
      title: object.goal.title,
      metric: object.goal.metric,
      targetValue: object.goal.targetValue,
    },
    rationale: object.goal.rationale,
  };
}
