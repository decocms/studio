import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { OnboardingTarget } from "./target";

// Real onboarding research — the elenchus made concrete. From an email we scrape
// the person's domain (Firecrawl), web-search who they are (Perplexity via
// OpenRouter), then synthesize TENTATIVE facts + a candidate goal (a capable
// OpenRouter model). Facts are proposals: the user confirms or rejects them.

export interface ResearchedFact {
  label: string;
  value: string;
  confidence: "low" | "medium" | "high";
  sourceUrl?: string;
}

export interface ResearchResult {
  facts: ResearchedFact[];
  target: OnboardingTarget;
  rationale: string;
}

// The onboarding research subject. Mocked to a fixed address — we don't have
// real signup data wired yet; override with TELOS_RESEARCH_EMAIL.
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

// Best-effort Firecrawl scrape of the email's domain. Returns markdown context
// for the synthesis step, or "" if the key is missing or the call fails.
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

  // 1) Scrape the domain + web-search the person in parallel.
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

  // 2) Synthesize tentative facts + a candidate goal from the gathered context.
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
