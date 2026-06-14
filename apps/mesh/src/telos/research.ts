import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { FactInput } from "@decocms/telos/postgres";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { OnboardingTarget } from "./target";

// Socratic intake (elenchus): from an email, research the person in a short loop —
// each round inspects what's known and asks the single most valuable next question —
// then synthesize tentative facts + a candidate goal. The goal is uncovered by
// questioning, not installed; an authority confirms it downstream.

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

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
// 3–5 rounds of questioning; clamp whatever is configured into that band.
const RESEARCH_STEPS = clamp(
  Number(process.env.TELOS_RESEARCH_STEPS ?? 4),
  3,
  5,
);

type Finding = { question: string; answer: string };
type OpenRouter = ReturnType<typeof createOpenRouter>;

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

// Decide whether we know enough, or what to ask next to fill the biggest gap.
const NextStep = z.object({
  done: z
    .boolean()
    .describe("true once we know enough about the user to set a first goal"),
  question: z
    .string()
    .describe(
      "the single most valuable next research question; ignored if done",
    ),
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
    const json = (await res.json()) as { data?: { markdown?: string } };
    return (json.data?.markdown ?? "").slice(0, 8_000);
  } catch (err) {
    console.warn("[telos] firecrawl failed", err);
    return "";
  }
}

// One web-research question (Perplexity via OpenRouter). Best-effort: "" on failure.
async function ask(openrouter: OpenRouter, question: string): Promise<string> {
  return generateText({
    model: openrouter(RESEARCH_MODEL),
    prompt: question,
  }).then(
    (r) => r.text,
    (err) => {
      console.warn("[telos] research step failed", err);
      return "";
    },
  );
}

function renderFindings(findings: Finding[]): string {
  return findings
    .map(
      (f, i) => `[${i + 1}] Q: ${f.question}\nA: ${f.answer.slice(0, 2_000)}`,
    )
    .join("\n\n");
}

async function planNextQuestion(
  openrouter: OpenRouter,
  email: string,
  domain: string,
  findings: Finding[],
): Promise<z.infer<typeof NextStep>> {
  const { object } = await generateObject({
    model: openrouter(SYNTH_MODEL),
    schema: NextStep,
    prompt:
      `You are researching a new user (email "${email}", domain "${domain}") of ` +
      `an MCP control plane, to learn enough to set them a first goal. What you ` +
      `have found so far:\n\n${renderFindings(findings)}\n\n` +
      `Do you know enough — who they are, their company/industry, team size, and ` +
      `what tools/integrations they'd plausibly use? If not, give the single most ` +
      `valuable next question to fill the biggest remaining gap.`,
  });
  return object;
}

export async function researchUser(email: string): Promise<ResearchResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const openrouter = createOpenRouter({ apiKey });

  const domain = (email.split("@")[1] ?? "").toLowerCase();

  const findings: Finding[] = [];
  const site = await scrapeDomain(domain);
  if (site)
    findings.push({ question: `Website content for ${domain}`, answer: site });

  let question =
    `Who is the person behind the email "${email}"? What does the company at ` +
    `"${domain}" do, and what is their likely role, industry, and team size? ` +
    `Be concise and cite what you find.`;

  for (let step = 0; step < RESEARCH_STEPS; step++) {
    findings.push({ question, answer: await ask(openrouter, question) });
    if (step === RESEARCH_STEPS - 1) break;
    const next = await planNextQuestion(openrouter, email, domain, findings);
    if (next.done || !next.question.trim()) break;
    question = next.question;
  }

  const { object } = await generateObject({
    model: openrouter(SYNTH_MODEL),
    schema: Synthesis,
    prompt:
      `You are onboarding a new user of an MCP control plane (they connect tools ` +
      `and run automations). From the research rounds below, extract up to 6 ` +
      `tentative facts about the user and propose ONE concrete first goal, ` +
      `measured by either "connections" (tools connected) or "automations_run". ` +
      `Choose the metric and a target value that genuinely fit what you learned — ` +
      `do not default to a fixed number.\n\n` +
      `EMAIL: ${email}\nDOMAIN: ${domain}\n\n${renderFindings(findings)}`,
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
