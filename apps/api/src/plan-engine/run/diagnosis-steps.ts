/**
 * The first half of a diagnosis: collect → capture → benchmark → probes →
 * opportunities → hypotheses (one step per batch). Each function is the body
 * of one durable step; dbos-ux-diagnosis.ts owns the sequence.
 */

import { orgHeatmap, orgLake } from "../adapters/analytics.ts";
import { orgBigQuery } from "../adapters/bigquery.ts";
import { codeAccessFor } from "../adapters/unavailable.ts";
import {
  captureCompetitorPage,
  captureCompetitorPdp,
  MAX_COMPETITORS,
  normalizeDomain,
  storeDescription,
  suggestCompetitors,
} from "../benchmark.ts";
import { browserFetcher, isStatusBotWall, withBrowser } from "../browser.ts";
import {
  captureDesignSystem,
  capturePdp,
  type CaptureTarget,
  captureSitePage,
} from "../capture.ts";
import { type CaptureCandidate, collectEvidence } from "../collect.ts";
import { costTotal, createCostCollector } from "../costs.ts";
import { checkDomain } from "../domain-check.ts";
import { buildFacts } from "../facts.ts";
import { CURATED_KNOWLEDGE } from "../knowledge/curated.ts";
import { opportunitiesFromLosses } from "../loss-opportunities.ts";
import {
  fallenLimit,
  fallenReason,
  generateOpportunityHypotheses,
} from "../opportunities.ts";
import { pageSpec } from "../page-types.ts";
import { candidatePdpUrls, resolvePdpUrl } from "../pdp-source.ts";
import {
  type BrowserPort,
  BrowserSessionError,
  type MediaStore,
  rethrowNoAiModel,
} from "../ports.ts";
import { type ProbeResult, runProbes } from "../probes.ts";
import type {
  BenchmarkPdp,
  DiagnosisEvidence,
  OpportunityDraft,
  PageCapture,
  SourceGap,
  UxDevice,
  UxPageType,
} from "../types.ts";
import type { EngineRun } from "./engine-run.ts";

/** An opportunity left with no hypothesis standing (see fallenReason). */
export interface FallenOpportunity {
  id: string;
  rank: number;
  title: string;
  reason: string;
}

export async function collectStep(
  run: EngineRun,
): Promise<{ targets: CaptureCandidate[]; cost: number }> {
  const { store, orgId, id, ctx } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "collect",
    progress_note: "lendo GA4, Deco Analytics, pedidos e estoque",
  });
  const [profile, current] = await Promise.all([
    store.getSiteProfile(orgId),
    store.getDiagnosis(orgId, id),
  ]);
  if (!profile) throw new Error("perfil da loja não configurado");
  const costs = createCostCollector(id);
  const result = await collectEvidence({
    profile,
    pageType: current?.page_type ?? "pdp",
    orgSlug: ctx.organization?.slug ?? "",
    heatmap: orgHeatmap(ctx),
    lake: orgLake(orgId),
    bigquery: await orgBigQuery(ctx, orgId),
    vtex: profile.domain ? { publicHost: profile.domain } : null,
    onScan: costs.scan,
  });
  result.evidence.gaps.push(codeAccessFor(profile).gap);
  // Routes read now serve the next runs too.
  if (result.page_templates) {
    await store
      .upsertSiteProfile(orgId, { page_templates: result.page_templates })
      .catch((err) =>
        result.evidence.gaps.push({
          source: "heatmap",
          error: `não gravei as rotas do site no perfil: ${err instanceof Error ? err.message : err}`,
        }),
      );
  }
  await run.recordCosts(`ux:${id}:collect`, costs.drafts);
  const evidence: DiagnosisEvidence = {
    ...result.evidence,
    captures: [],
    benchmark: [],
  };
  await store.updateDiagnosis(orgId, id, { evidence });
  return { targets: result.capture_targets, cost: costTotal(costs) };
}

/** Design system (do render) com menos de uma semana é reaproveitado. */
const DESIGN_SYSTEM_MAX_AGE_DAYS = 7;

const isStale = (at: string | null | undefined) =>
  !at || Date.now() - Date.parse(at) > DESIGN_SYSTEM_MAX_AGE_DAYS * 86_400_000;

const hostOf = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Os elementos do heatmap de cada dispositivo: a captura diz o que cada um é. */
const elementKeysFor = (evidence: DiagnosisEvidence, device: UxDevice) =>
  (evidence.pdp_behaviour.find((b) => b.device === device)?.elements ?? []).map(
    (e) => `${e.root}|${e.el}`,
  );

/**
 * Captura de home, categoria ou busca: a página que a coleta escolheu (a rota
 * do heatmap), nos dois dispositivos, com os elementos do heatmap rotulados.
 * Sem design system: ele é lido da PDP (botão de compra, chip de tamanho), e
 * a análise da PDP cuida disso.
 */
async function captureOtherPage(opts: {
  browser: BrowserPort;
  media: MediaStore;
  id: string;
  pageType: Exclude<UxPageType, "pdp" | "carrinho_checkout">;
  targets: CaptureCandidate[];
  evidence: DiagnosisEvidence;
  captures: PageCapture[];
}): Promise<void> {
  const { evidence } = opts;
  const main = opts.targets[0];
  if (!main) {
    evidence.gaps.push({
      source: "browser",
      error: `não achei uma página de ${pageSpec(opts.pageType).label.toLowerCase()} pra abrir`,
    });
    return;
  }
  for (const device of ["mobile", "desktop"] as const) {
    try {
      opts.captures.push(
        await captureSitePage(
          opts.browser,
          opts.media,
          { url: main.url, product_id: null },
          device,
          `ux/${opts.id}/${opts.pageType}`,
          opts.pageType,
          elementKeysFor(evidence, device),
        ),
      );
    } catch (err) {
      evidence.gaps.push({
        source: "browser",
        error: `captura ${device}: ${errorText(err)}`,
      });
    }
  }
}

/** The real pages in the browser: the PDPs (or the page under analysis) and the design system. */
export async function captureStep(
  run: EngineRun,
  collected: CaptureCandidate[],
): Promise<number> {
  const { store, orgId, id } = run;
  const diagnosis = await store.getDiagnosis(orgId, id);
  const evidence = diagnosis?.evidence;
  if (!evidence) throw new Error("evidências do collect sumiram");
  const pageType = diagnosis?.page_type ?? "pdp";
  // Cart and checkout belong to the platform: data only.
  if (pageType === "carrinho_checkout") return 0;
  await store.updateDiagnosis(orgId, id, {
    stage: "capture",
    progress_note: `abrindo ${pageType === "pdp" ? "a PDP" : pageSpec(pageType).noun} no celular e no computador`,
  });
  const session = await run.browser();
  if ("gap" in session) {
    evidence.gaps.push(session.gap);
    await store.updateDiagnosis(orgId, id, { evidence });
    return 0;
  }
  const { media } = session;
  const profile = await store.getSiteProfile(orgId);
  const now = new Date().toISOString();
  const captures: PageCapture[] = [];
  await withBrowser(session.port, async (browser) => {
    if (pageType !== "pdp") {
      await captureOtherPage({
        browser,
        media,
        id,
        pageType,
        targets: collected,
        evidence,
        captures,
      });
      return;
    }
    const targets: CaptureTarget[] = [];
    for (const t of collected) {
      if (t.product_id) {
        targets.push({
          url: t.url,
          product_id: t.product_id,
          stock: t.stock ?? null,
        });
        continue;
      }
      // Sem produto da rodada: uma PDP dos dados que já temos; a home é o último recurso.
      if (!profile) continue;
      const url = await resolvePdpUrl(
        browser,
        profile.domain,
        await candidatePdpUrls({
          store,
          orgId,
          domain: profile.domain,
          vtex: profile.domain ? { publicHost: profile.domain } : null,
        }),
      );
      if (url) targets.push({ url, product_id: null });
    }
    const [main, soldOut] = targets;
    if (!main) {
      evidence.gaps.push({
        source: "browser",
        error: "nenhuma PDP encontrada pra abrir",
      });
      return;
    }
    for (const device of ["mobile", "desktop"] as const) {
      try {
        captures.push(
          await capturePdp(
            browser,
            media,
            main,
            device,
            `ux/${id}/pdp-main`,
            elementKeysFor(evidence, device),
          ),
        );
      } catch (err) {
        evidence.gaps.push({
          source: "browser",
          error: `captura ${device}: ${errorText(err)}`,
        });
      }
    }
    if (soldOut) {
      try {
        captures.push(
          await capturePdp(
            browser,
            media,
            soldOut,
            "mobile",
            `ux/${id}/pdp-soldout`,
          ),
        );
      } catch (err) {
        evidence.gaps.push({
          source: "browser",
          error: `captura da esgotada: ${errorText(err)}`,
        });
      }
    }
    // Velho, ou lido noutro host (o domínio mudou, ex.: apex → www).
    const dsHost = hostOf(profile?.design_system?.source_url);
    if (
      isStale(profile?.design_system_at) ||
      (profile && dsHost !== profile.domain)
    ) {
      try {
        const ds = await captureDesignSystem(
          browser,
          media,
          main.url,
          `ux/design-system/${now.slice(0, 10)}`,
          now,
        );
        await store.saveDesignSystem(orgId, ds);
      } catch (err) {
        evidence.gaps.push({
          source: "browser",
          error: `design system: ${errorText(err)}`,
        });
      }
    }
  });
  evidence.captures = captures;
  await store.updateDiagnosis(orgId, id, { evidence });
  return 0;
}

/**
 * Até quando o benchmark começa uma loja nova. Folga dentro dos 15 min do
 * WORK_STEP pra a loja em andamento terminar e o passo gravar.
 */
const BENCHMARK_BUDGET_MS = 10 * 60_000;

/** Teto de uma loja do benchmark (home, vitrines, PDP, print e leitura). */
const COMPETITOR_TIMEOUT_MS = 150_000;

/** `p`, ou erro com `message` se não resolver em `ms`. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Erro de sessão do navegador (vale tentar de novo), não do site. */
function isBrowserCrash(err: unknown): boolean {
  if (err instanceof BrowserSessionError) return true;
  return /Target closed|Connection closed|Protocol error|Session closed|WebSocket/i.test(
    errorText(err),
  );
}

/**
 * The same pages at competitors: the saved list, then (unless the customer
 * confirmed it) suggestions until there are enough. Without a browser only
 * the fresh cached captures come in, and no competitor is suggested.
 */
export async function benchmarkStep(run: EngineRun): Promise<number> {
  const { store, orgId, id } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "benchmark",
    progress_note: "olhando as mesmas páginas em concorrentes",
  });
  const diagnosis = await store.getDiagnosis(orgId, id);
  const evidence = diagnosis?.evidence;
  const profile = await store.getSiteProfile(orgId);
  if (!evidence || !profile) throw new Error("diagnóstico sem evidências");
  const pageType = diagnosis?.page_type ?? "pdp";
  // Cart and checkout: no page of ours to compare.
  if (pageType === "carrinho_checkout") return 0;
  const costs = createCostCollector(id);
  const gaps: SourceGap[] = [];
  const saved = profile.competitors
    .map(normalizeDomain)
    .filter((d): d is string => d !== null);
  const benchmark: BenchmarkPdp[] = [];
  // Prazo pra começar uma loja nova: uma loja lenta leva vários minutos.
  const deadline = Date.now() + BENCHMARK_BUDGET_MS;
  let session: { port: BrowserPort; media: MediaStore } | null | undefined;
  const opened = async () => {
    if (session === undefined) {
      const s = await run.browser();
      session = "gap" in s ? null : s;
    }
    return session;
  };

  const tryDomain = async (domain: string) => {
    const cached = await store.getFreshBenchmark(orgId, domain, pageType);
    if (cached) {
      benchmark.push(cached);
      return;
    }
    const s = await opened();
    if (!s) return;
    if (Date.now() > deadline) {
      gaps.push({
        source: "benchmark",
        error: `${domain}: sem tempo nesta rodada`,
      });
      return;
    }
    // Uma sessão POR LOJA, com uma segunda tentativa: a loja que derruba o navegador não leva as outras.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const now = new Date().toISOString();
        const competitor = {
          media: s.media,
          llm: run.llm,
          mediaUrl: run.mediaUrl,
          domain,
          keyPrefix: `ux/benchmark/${now.slice(0, 10)}`,
          now,
          budgetMs: COMPETITOR_TIMEOUT_MS,
          onUsage: costs.llm,
        };
        // Teto por loja: fechar a sessão (withBrowser) derruba o que estiver pendurado.
        const b = await withBrowser(s.port, (browser) =>
          withTimeout(
            pageType === "pdp"
              ? captureCompetitorPdp({ ...competitor, browser })
              : captureCompetitorPage({
                  ...competitor,
                  browser,
                  pageType,
                  searchTerm: evidence.search_term ?? null,
                }),
            COMPETITOR_TIMEOUT_MS,
            `passou de ${COMPETITOR_TIMEOUT_MS / 1000}s procurando ${pageType === "pdp" ? "uma PDP" : pageSpec(pageType).noun}`,
          ),
        );
        await store.upsertBenchmark(orgId, b);
        benchmark.push(b);
        return;
      } catch (err) {
        rethrowNoAiModel(err);
        lastError = err;
        // Só a queda do navegador merece outra tentativa: muro, "sem produto" ou "não é HTML" é o site.
        console.warn(
          `[plan-engine] [${id}] benchmark ${domain} tentativa ${attempt}: ${errorText(err)}`,
        );
        if (!isBrowserCrash(err)) break;
      }
    }
    gaps.push({
      source: "benchmark",
      error: `${domain}: ${errorText(lastError)}`,
      ...(isStatusBotWall(lastError) ? { owner: "external" as const } : {}),
    });
  };

  for (const domain of saved) {
    if (benchmark.length >= MAX_COMPETITORS) break;
    await tryDomain(domain);
  }

  // Lista confirmada pelo cliente é escolha dele: não se completa com sugestão.
  const confirmed = profile.competitors_confirmed_at !== null;
  const s =
    !confirmed && benchmark.length < MAX_COMPETITORS ? await opened() : null;
  if (s) {
    let suggested: string[] = [];
    try {
      suggested = await suggestCompetitors({
        llm: run.llm,
        domain: profile.domain,
        storeDescription: await storeDescription(s.port, profile.domain),
        exclude: saved,
        onUsage: costs.llm,
      });
      // Só entra sugestão cujo domínio abre e deixa robô passar.
      const fetcher = browserFetcher(s.port, DOMAIN_CHECK_FETCH);
      const checks = await Promise.all(
        suggested.map((d) => checkDomain(d, fetcher)),
      );
      suggested = checks.flatMap((c) =>
        c.ok && !c.blocks_bots ? [c.host] : [],
      );
    } catch (err) {
      rethrowNoAiModel(err);
      gaps.push({
        source: "benchmark",
        error: `sugestão de concorrentes: ${errorText(err)}`,
      });
    }
    for (const domain of suggested) {
      if (benchmark.length >= MAX_COMPETITORS) break;
      await tryDomain(domain);
    }
  }

  // Só a PDP reescreve a lista guardada, pras lojas que abriram: busca e vitrine falham mais.
  const captured = benchmark.map((b) => b.domain);
  if (
    pageType === "pdp" &&
    !confirmed &&
    captured.length > 0 &&
    captured.join(",") !== saved.join(",")
  ) {
    await store.replaceSuggestedCompetitors(orgId, captured);
  }
  evidence.benchmark = benchmark;
  evidence.gaps.push(...gaps);
  await store.updateDiagnosis(orgId, id, { evidence });
  await run.recordCosts(`ux:${id}:benchmark`, costs.drafts);
  return costTotal(costs);
}

/** The domain check only reads the status: no body. */
const DOMAIN_CHECK_FETCH = { maxBytes: 0, timeoutMs: 8_000 };

/** Até quando uma sonda pode começar. */
const PROBES_BUDGET_MS = 6 * 60_000;

/** What the page does (pop-ups, dead clicks), measured before any hypothesis. */
export async function probesStep(run: EngineRun): Promise<void> {
  const { store, orgId, id } = run;
  const diagnosis = await store.getDiagnosis(orgId, id);
  const evidence = diagnosis?.evidence;
  // Já rodou (replay) ou o livro de fatos já foi gravado: não mexe.
  if (!evidence || evidence.probes || evidence.facts?.length) return;
  if (evidence.captures.length === 0) return;
  const browser = await run.browser();
  if ("gap" in browser) return;
  await store.updateDiagnosis(orgId, id, {
    stage: "opportunities",
    progress_note: "tocando na página: pop-ups e cliques mortos",
  });
  const probes = await withBrowser(browser.port, (b) =>
    runProbes({
      browser: b,
      evidence,
      media: browser.media,
      keyPrefix: `ux/${id}/sondas`,
      deadline: Date.now() + PROBES_BUDGET_MS,
    }),
  ).catch((err: unknown): ProbeResult[] => [
    {
      kind: "camadas",
      device: "mobile",
      url: evidence.captures[0]?.url ?? "",
      ok: false,
      error: `o navegador não abriu: ${errorText(err)}`,
    },
  ]);
  await store.updateDiagnosis(orgId, id, { evidence: { ...evidence, probes } });
}

export async function opportunitiesStep(run: EngineRun): Promise<{
  ids: string[];
  reserves: OpportunityDraft[];
  cost: number;
}> {
  const { store, orgId, id } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "opportunities",
    progress_note: "achando as oportunidades da página",
  });
  const diagnosis = await store.getDiagnosis(orgId, id);
  const profile = await store.getSiteProfile(orgId);
  if (!diagnosis?.evidence || !profile) {
    throw new Error("diagnóstico sem evidências");
  }
  // Written once, so a hypothesis's fact ids point at the same facts later.
  const evidence = diagnosis.evidence.facts?.length
    ? diagnosis.evidence
    : { ...diagnosis.evidence, facts: buildFacts(diagnosis.evidence) };
  if (evidence !== diagnosis.evidence) {
    await store.updateDiagnosis(orgId, id, { evidence });
  }
  const result = opportunitiesFromLosses(evidence);
  const saved = await store.replaceOpportunities(
    orgId,
    id,
    result.opportunities,
    [],
  );
  await store.updateDiagnosis(orgId, id, { summary: result.summary });
  return { ids: saved.map((o) => o.id), reserves: result.reserves, cost: 0 };
}

export async function hypothesesStep(
  run: EngineRun,
  batch: string[],
  index: number,
  batches: number,
): Promise<{ cost: number; fallen: FallenOpportunity[] }> {
  const { store, orgId, id } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "hypotheses",
    progress_note: `hipóteses: lote ${index + 1} de ${batches}`,
  });
  const costs = createCostCollector(id);
  const [diagnosis, opportunities, profile, knowledge] = await Promise.all([
    store.getDiagnosis(orgId, id),
    store.listOpportunities(orgId, id),
    store.getSiteProfile(orgId),
    run.knowledge.knowledgeForRun(orgId, CURATED_KNOWLEDGE),
  ]);
  const evidence = diagnosis?.evidence;
  const mine = opportunities.filter((o) => batch.includes(o.id));
  const fell: FallenOpportunity[] = [];
  if (!evidence || !profile || mine.length === 0) {
    return { cost: 0, fallen: fell };
  }
  const summary = diagnosis?.summary ?? null;
  try {
    const result = await generateOpportunityHypotheses({
      llm: run.llm,
      domain: profile.domain,
      evidence,
      opportunities: mine,
      onUsage: costs.llm,
      knowledge: knowledge.entries,
      objective: diagnosis?.objective_statement,
      mediaUrl: run.mediaUrl,
    });
    for (const o of mine) {
      await store.replaceOpportunityHypotheses(
        orgId,
        id,
        o.id,
        result.byOpportunity.get(o.id) ?? [],
      );
      await store.saveOpportunityTreeNotes(
        orgId,
        o.id,
        result.discarded?.get(o.id) ?? [],
      );
      const reason = fallenReason(result, o.id);
      if (reason) {
        fell.push({ id: o.id, rank: o.rank, title: o.title, reason });
      }
    }
    if (summary) {
      // A fallen opportunity's drops go in its own "Tiramos" line.
      const ofFallen = new Set(
        fell.flatMap((f) => result.droppedBy.get(f.id) ?? []),
      );
      const dropped = result.dropped.filter((d) => !ofFallen.has(d));
      if (dropped.length > 0) {
        summary.limits.push(`Hipóteses que caíram: ${dropped.join("; ")}.`);
      }
      for (const f of fell) summary.limits.push(fallenLimit(f.title, f.reason));
      await store.updateDiagnosis(orgId, id, { summary });
    }
  } catch (err) {
    rethrowNoAiModel(err);
    // A failed batch leaves its opportunities without hypotheses, and says why.
    const message = err instanceof Error ? err.message : String(err);
    if (summary) {
      summary.limits.push(
        `As hipóteses de ${mine.map((o) => `"${o.title}"`).join(", ")} não saíram: ${message}`,
      );
      summary.hypothesis_notes = {
        ...summary.hypothesis_notes,
        ...Object.fromEntries(mine.map((o) => [o.id, message])),
      };
      await store.updateDiagnosis(orgId, id, { summary });
    }
  }
  await run.recordCosts(`ux:${id}:hypotheses:${index + 1}`, costs.drafts);
  return { cost: costTotal(costs), fallen: fell };
}
