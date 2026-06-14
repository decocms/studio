import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { FactInput } from "@decocms/telos/postgres";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { type CatalogApp, catalogForPrompt, validateTools } from "./catalog";
import type { OnboardingTarget } from "./target";

// Socratic intake (elenchus): from a signup identity (name + email), research the
// person in a short web-search loop — each round inspects what's known and asks
// the single most valuable next question — then synthesize tentative facts + a
// candidate goal. Two principles keep it honest:
//   1. Identity-anchored: the person's NAME drives the search; without it we can
//      only find the company, never the individual.
//   2. Cited-or-dropped: every fact must point at a real source URL we actually
//      visited. Facts the model can't cite are discarded, not shown — this is
//      what stops it inventing a role/tools out of thin air.

export interface ResearchSubject {
  email: string;
  name?: string;
}

export interface ResearchResult {
  facts: FactInput[];
  target: OnboardingTarget;
  rationale: string;
}

// Mocked research subject — used only as the last-resort fallback when a signup
// carries no email. Override the whole subject with TELOS_RESEARCH_EMAIL /
// TELOS_RESEARCH_NAME for local testing.
export const RESEARCH_EMAIL =
  process.env.TELOS_RESEARCH_EMAIL ?? "pedrofrxncx@deco.cx";

// Resolve the subject to research from a signup, honoring test overrides.
export function researchSubject(
  email?: string | null,
  name?: string | null,
): ResearchSubject {
  return {
    email: process.env.TELOS_RESEARCH_EMAIL ?? email ?? RESEARCH_EMAIL,
    name: process.env.TELOS_RESEARCH_NAME ?? name ?? undefined,
  };
}

// Perplexity sonar searches the web and returns citations; the synth model turns
// findings into grounded facts + a goal. Default synth to a strong model — a weak
// one pads to the fact limit and confabulates.
const RESEARCH_MODEL = process.env.TELOS_RESEARCH_MODEL ?? "perplexity/sonar";
const SYNTH_MODEL =
  process.env.TELOS_SYNTH_MODEL ?? "anthropic/claude-sonnet-4.6";

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
// 3–5 rounds of questioning; clamp whatever is configured into that band.
const RESEARCH_STEPS = clamp(
  Number(process.env.TELOS_RESEARCH_STEPS ?? 4),
  3,
  5,
);

type Source = { url: string; title: string };
type Finding = { question: string; answer: string; sources: Source[] };
type OpenRouter = ReturnType<typeof createOpenRouter>;

const Synthesis = z.object({
  facts: z
    .array(
      z.object({
        label: z.string().describe("short noun, e.g. 'Company' or 'GitHub'"),
        value: z.string().describe("the finding, one concise sentence"),
        confidence: z.enum(["low", "medium", "high"]),
        sourceUrl: z
          .string()
          .describe(
            "the EXACT url from the SOURCES list that backs this fact; if no " +
              "source backs it, do not include the fact at all",
          ),
      }),
    )
    .describe(
      "at most 5 facts you can attribute to a listed source; omit anything you " +
        "cannot cite — fewer grounded facts beat many guesses",
    ),
  goal: z.object({
    title: z
      .string()
      .describe(
        "a concrete, outcome-framed first goal that NAMES the tools, e.g. " +
          "'Connect GitHub and a CMS to automate your release notes' — never a " +
          "generic count like 'connect 3 tools'",
      ),
    tools: z
      .array(
        z.object({
          label: z
            .string()
            .describe("display name of the tool to connect, e.g. 'GitHub'"),
          match: z
            .array(z.string())
            .describe(
              "lowercase keywords that identify this tool in a connection's " +
                "name/app, e.g. ['github'] or " +
                "['contentful','sanity','strapi','wordpress','cms']",
            ),
        }),
      )
      .describe(
        "2-3 integrations to connect first, chosen ONLY from the supported tools " +
          "list in the prompt — use their exact names, never invent an app",
      ),
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

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

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

// Firecrawl web search: a second source of real URLs so person facts survive even
// when sonar returns no citations. Returns ranked results (url + title + snippet).
// Best-effort: [] if the key is missing or the search fails.
async function searchWeb(query: string): Promise<Source[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key || !query) return [];
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ query, limit: 5 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[telos] firecrawl search → ${res.status}`);
      return [];
    }
    const json = (await res.json()) as {
      data?: Array<{ url?: string; title?: string; description?: string }>;
    };
    return (json.data ?? [])
      .filter((r): r is { url: string; title?: string; description?: string } =>
        Boolean(r.url),
      )
      .map((r) => ({ url: r.url, title: r.title || r.description || r.url }));
  } catch (err) {
    console.warn("[telos] firecrawl search failed", err);
    return [];
  }
}

// One web-research question (Perplexity via OpenRouter). Returns the answer plus
// the citation URLs the model used. Best-effort: empty on failure.
async function ask(
  openrouter: OpenRouter,
  question: string,
): Promise<{ text: string; sources: Source[] }> {
  return generateText({
    model: openrouter(RESEARCH_MODEL),
    prompt: question,
  }).then(
    (r) => ({
      text: r.text,
      sources: (r.sources ?? [])
        .filter((s): s is typeof s & { url: string } => "url" in s && !!s.url)
        .map((s) => ({
          url: s.url,
          title: ("title" in s && s.title) || s.url,
        })),
    }),
    (err) => {
      console.warn("[telos] research step failed", err);
      return { text: "", sources: [] };
    },
  );
}

function renderFindings(findings: Finding[]): string {
  return findings
    .map((f, i) => {
      const cites = f.sources.length
        ? `\nSources: ${f.sources.map((s) => s.url).join(", ")}`
        : "";
      return `[${i + 1}] Q: ${f.question}\nA: ${f.answer.slice(0, 2_000)}${cites}`;
    })
    .join("\n\n");
}

function renderSources(sources: Map<string, string>): string {
  const items = [...sources.entries()];
  if (!items.length) return "(no source URLs were captured)";
  return items
    .map(([url, title], i) => `[${i + 1}] ${title} — ${url}`)
    .join("\n");
}

async function planNextQuestion(
  openrouter: OpenRouter,
  subject: ResearchSubject,
  domain: string,
  findings: Finding[],
): Promise<z.infer<typeof NextStep>> {
  const who = subject.name
    ? `${subject.name} <${subject.email}>`
    : `<${subject.email}>`;
  const { object } = await generateObject({
    model: openrouter(SYNTH_MODEL),
    schema: NextStep,
    prompt:
      `You are researching a new user (${who}, company domain "${domain}") of ` +
      `an MCP control plane, to learn enough to set them a first goal. What you ` +
      `have found so far:\n\n${renderFindings(findings)}\n\n` +
      `Do you have specific, citable details — who they are, their public ` +
      `profiles (GitHub/LinkedIn/site), what they build, the company's product, ` +
      `industry and team size? If not, give the single most valuable next ` +
      `question to fill the biggest gap. Favor questions that surface concrete, ` +
      `verifiable facts with URLs over generic ones.`,
  });
  return object;
}

// Best-effort live trace of the research as it runs. Called from the durable
// research step, so it may repeat across retries — fine for ephemeral SSE.
export type OnThought = (text: string) => void;

export async function researchUser(
  subject: ResearchSubject,
  catalog: CatalogApp[],
  onThought?: OnThought,
): Promise<ResearchResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const openrouter = createOpenRouter({ apiKey });

  const { email, name } = subject;
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const think = (text: string) => onThought?.(text);

  // Every URL we actually visited; a fact may only cite a host in this set.
  const sources = new Map<string, string>();
  const allowedHosts = new Set<string>();
  const remember = (s: Source[]) => {
    for (const { url, title } of s) {
      if (!sources.has(url)) sources.set(url, title);
      const h = hostOf(url);
      if (h) allowedHosts.add(h);
    }
  };

  const findings: Finding[] = [];
  if (domain) think(`Looking up ${domain}…`);
  const site = await scrapeDomain(domain);
  if (site) {
    findings.push({
      question: `Website content for ${domain}`,
      answer: site,
      sources: [{ url: `https://${domain}`, title: domain }],
    });
    remember([{ url: `https://${domain}`, title: domain }]);
  }
  if (domain) allowedHosts.add(domain);

  // Second source: a direct web search for the person's profiles. This seeds real,
  // citable URLs (GitHub/LinkedIn/etc.) into the allow-set so person facts survive
  // even when sonar returns no citations of its own.
  if (name) {
    think(`Searching for ${name}'s profiles…`);
    const hits = await searchWeb(
      `${name} ${domain} GitHub OR LinkedIn OR personal site`,
    );
    if (hits.length) {
      remember(hits);
      findings.push({
        question: `Web search for ${name} (${domain})`,
        answer: hits.map((h) => `- ${h.title}: ${h.url}`).join("\n"),
        sources: hits,
      });
    }
  }

  // Identity-anchored seed questions. The person's name is the search key; the
  // company query grounds industry/size. Order person-first when we have a name.
  const who = name
    ? `${name} (email ${email})`
    : `the person with email ${email}`;
  const personQ =
    `Research ${who}, who works at the company on domain "${domain}". Find ` +
    `their professional footprint and return EXACT source URLs: GitHub profile ` +
    `and notable repositories, LinkedIn, personal site or blog, X/Twitter, any ` +
    `conference talks or articles, and what they build or specialize in. Only ` +
    `state things you can cite with a URL. If you cannot find the specific ` +
    `person, say so plainly rather than guessing.`;
  const companyQ =
    `What does the company at "${domain}" do? Its product, industry, stage, and ` +
    `approximate team size. Cite every claim with a source URL.`;

  const queue: string[] = name ? [personQ, companyQ] : [companyQ, personQ];
  let asked = 0;
  while (asked < RESEARCH_STEPS) {
    let question = queue.shift();
    if (!question) {
      const next = await planNextQuestion(
        openrouter,
        subject,
        domain,
        findings,
      );
      if (next.done || !next.question.trim()) break;
      question = next.question;
    }
    think(question);
    const { text, sources: s } = await ask(openrouter, question);
    findings.push({ question, answer: text, sources: s });
    remember(s);
    asked++;
  }

  think("Synthesizing what I found into your first goal…");
  const { object } = await generateObject({
    model: openrouter(SYNTH_MODEL),
    schema: Synthesis,
    prompt:
      `You are onboarding a new user of an MCP control plane (they connect tools ` +
      `and run automations). Below are research rounds and the SOURCES we ` +
      `actually visited.\n\n` +
      `Extract tentative facts about the user, then propose ONE concrete first ` +
      `goal: connect 2-3 high-value integrations this person should wire up first, ` +
      `CHOSEN ONLY from this list of tools we actually support — use their exact ` +
      `names, never invent an app:\n  ${catalogForPrompt(catalog)}\n` +
      `Pick the ones most relevant to what they do. Frame the title around the ` +
      `outcome those tools unlock.\n\n` +
      `HARD RULES for facts:\n` +
      `- Every fact MUST set sourceUrl to an exact URL from SOURCES that backs ` +
      `it. If nothing in SOURCES backs a claim, OMIT the fact entirely.\n` +
      `- Never infer a person's role, tools, focus, or seniority without a ` +
      `citation. Do not write "likely", "probably", or "appears to be".\n` +
      `- Prefer specific, verifiable facts (their actual GitHub, what they ship, ` +
      `the company's real product) over generic filler. Fewer is better.\n\n` +
      `SUBJECT: ${name ?? "(unknown name)"} <${email}>   DOMAIN: ${domain}\n\n` +
      `SOURCES:\n${renderSources(sources)}\n\n` +
      `RESEARCH:\n${renderFindings(findings)}`,
  });

  // Cited-or-dropped: keep only facts whose sourceUrl host is one we visited.
  // This is the programmatic backstop against confabulation — a fact that cites
  // a URL we never saw (or none) is discarded regardless of how confident it is.
  const facts: FactInput[] = object.facts
    .filter((f) => f.sourceUrl && allowedHosts.has(hostOf(f.sourceUrl)))
    .slice(0, 5)
    .map((f) => ({
      label: f.label,
      value: f.value,
      confidence: f.confidence,
      sourceUrl: f.sourceUrl,
    }));

  // Validate the proposed tools against the real catalog — drop anything that
  // isn't an app we actually support, attach canonical slugs for the connect
  // links. If the model picked nothing real, fall back to the top catalog apps so
  // the goal is never empty.
  const tools = validateTools(object.goal.tools, catalog);
  const finalTools = tools.length
    ? tools
    : catalog.slice(0, 2).map((a) => ({
        label: a.label,
        appName: a.appName,
        match: a.match,
        icon: a.icon,
      }));

  return {
    facts,
    target: { title: object.goal.title, tools: finalTools },
    rationale: object.goal.rationale,
  };
}

// Re-fit the first goal from facts the user has CONFIRMED about themselves. The
// user editing facts is strong signal; this turns it into a possibly-updated goal.
// Conservative by design: returns null (no change) unless the confirmed facts
// clearly imply a different metric or target. No numeric schema constraints (the
// structured-output validator rejects them); the target is clamped in code.
export async function refitGoalFromFacts(
  confirmed: Array<{ label: string; value: string }>,
  current: OnboardingTarget,
  catalog: CatalogApp[],
): Promise<OnboardingTarget | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || confirmed.length === 0) return null;
  const openrouter = createOpenRouter({ apiKey });

  const { object } = await generateObject({
    model: openrouter(SYNTH_MODEL),
    schema: z.object({
      change: z
        .boolean()
        .describe("true ONLY if the goal should change; conservative default"),
      title: z.string(),
      tools: z.array(
        z.object({
          label: z.string(),
          match: z.array(z.string()),
        }),
      ),
    }),
    prompt:
      `A new user CONFIRMED these facts about themselves:\n` +
      confirmed.map((f) => `- ${f.label}: ${f.value}`).join("\n") +
      `\n\nTheir current onboarding goal: "${current.title}" — connect: ` +
      `${current.tools.map((t) => t.label).join(", ")}.\n\n` +
      `If the confirmed facts clearly imply a better set of first tools to ` +
      `connect — CHOSEN ONLY from this supported list, exact names, never invent ` +
      `one: ${catalogForPrompt(catalog)} — set change=true and provide an updated ` +
      `title + tools. Otherwise set change=false and echo the current goal. Be ` +
      `conservative — only change the goal when the facts plainly warrant it.`,
  });

  if (!object.change) return null;
  const tools = validateTools(object.tools, catalog);
  if (tools.length === 0) return null;
  const next: OnboardingTarget = { title: object.title, tools };
  // No-op if effectively identical to the current goal.
  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  return next;
}
