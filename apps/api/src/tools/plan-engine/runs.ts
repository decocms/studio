/**
 * Starting work in the built-in engine: a new diagnosis run, and verifying an
 * existing diagnosis again. Both answer at once and leave the work to the
 * planUxDiagnosisWorkflow; the Plan page follows it with the read tools.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import type { StudioContext } from "@/core/studio-context";
import { codeAccessFor } from "@/plan-engine/adapters/unavailable";
import type {
  StartedDiagnosis,
  StartUxDiagnosisOutput,
} from "@/plan-engine/contract";
import { startUxDiagnosisWorkflow } from "@/plan-engine/dbos-ux-diagnosis";
import { PAGE_TYPE_ORDER } from "@/plan-engine/page-types";
import { buildSetup } from "@/plan-engine/setup";
import type { UxDiagnosis, UxPageType } from "@/plan-engine/types";
import { reverifyBlock } from "@/plan-engine/verify/index";
import { getSettings } from "@/settings";
import { engineOrg, errorOf, Row } from "./gate";
import { syncProfileFromStudio } from "./profile";

const PAGE_TYPE_ENUM = z.enum([
  "home",
  "categoria",
  "busca",
  "pdp",
  "carrinho_checkout",
]);

const StartInputSchema = z.object({
  page_type: PAGE_TYPE_ENUM.optional(),
  todas: z.boolean().optional(),
  pages: z
    .array(PAGE_TYPE_ENUM)
    .min(1)
    .max(PAGE_TYPE_ORDER.length)
    .refine((p) => new Set(p).size === p.length, "páginas repetidas")
    .optional()
    .describe("As páginas desta rodada (1 a 5, sem repetir)"),
  goal_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("A meta ativa no Plan; fica gravada na rodada"),
  objective_statement: z
    .string()
    .max(280)
    .optional()
    .describe("O texto da meta: contexto das hipóteses e do dossiê"),
});

const StartOutputSchema = z.union([
  z.object({
    status: z.literal("started"),
    site_run_id: z.string(),
    diagnoses: z.array(
      z.object({
        page_type: PAGE_TYPE_ENUM,
        diagnosis_id: z.string(),
        already_running: z.boolean(),
      }),
    ),
  }),
  z.object({
    status: z.literal("error"),
    error: z.string(),
    needs_domain: z.literal(true).optional(),
    needs: z.array(Row).optional(),
  }),
]);

const DAY_MS = 24 * 60 * 60_000;

/** The pages asked for: `todas` = all five; `pages`; or `page_type` (default pdp). */
function requestedPages(input: z.infer<typeof StartInputSchema>): UxPageType[] {
  if (input.todas) return [...PAGE_TYPE_ORDER];
  if (input.pages)
    return PAGE_TYPE_ORDER.filter((p) => input.pages?.includes(p));
  return [input.page_type ?? "pdp"];
}

/** The member the run reads and spends as. */
function principalOf(ctx: StudioContext): string {
  const userId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId;
  if (!userId) throw new Error("a member is required to start a diagnosis");
  return userId;
}

export const PLAN_UX_DIAGNOSIS_START = defineTool({
  name: "PLAN_UX_DIAGNOSIS_START",
  description:
    "Começa um diagnóstico de UI/UX (dados → oportunidades → hipóteses → teste) numa rodada nova. Escolha as páginas (pages: home, categoria, busca, pdp, carrinho_checkout), uma só (page_type, padrão pdp) ou o site inteiro (todas: true); um diagnóstico por página, todos ao mesmo tempo. Página que já está rodando volta como está (already_running), sem outra. goal_id e objective_statement gravam a meta na rodada. Volta na hora com os ids; acompanhe com PLAN_UX_STORE_VIEW ou PLAN_UX_DIAGNOSIS_GET.",
  annotations: {
    title: "Start Store Diagnosis",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: StartInputSchema,
  outputSchema: StartOutputSchema,
  requiresAiBudget: true,
  handler: async (raw, ctx): Promise<StartUxDiagnosisOutput> => {
    const org = await engineOrg(ctx);
    const userId = principalOf(ctx);
    const parsed = StartInputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "error",
        error: `entrada inválida: ${parsed.error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`).join("; ")}`,
      };
    }
    const input = parsed.data;
    const store = ctx.storage.planEngine;

    // The store comes from Studio on every run; a failed read keeps the profile.
    let synced: Awaited<ReturnType<typeof syncProfileFromStudio>>;
    try {
      synced = await syncProfileFromStudio(ctx, org);
    } catch (err) {
      const profile = await store.getSiteProfile(org.id);
      synced = { profile, sources: profile?.sources ?? null };
      console.warn(`[plan-engine] store detection failed: ${errorOf(err)}`);
    }
    const profile = synced.profile;
    if (!profile) {
      return {
        status: "error",
        error:
          "não achei o site desta org no Studio — informe o domínio da loja" +
          (synced.sources?.errors.length
            ? ` (${synced.sources.errors.join("; ")})`
            : ""),
        needs_domain: true,
        needs: buildSetup(null, []).needs,
      };
    }

    // Every analysis is a run, even of one page: it is what the Plan lists.
    const siteRunId = crypto.randomUUID();
    const goal = {
      goal_id: input.goal_id ?? null,
      objective_statement: input.objective_statement?.trim() || null,
    };

    try {
      // Each page is a start: the whole run has to fit under the cap.
      const pages = requestedPages(input);
      const startedToday = await store.countDiagnosesStartedSince(
        org.id,
        new Date(Date.now() - DAY_MS).toISOString(),
      );
      if (
        startedToday + pages.length >
        getSettings().planEngineMaxDailyStarts
      ) {
        return { status: "error", error: "limite diário de análises atingido" };
      }
      await store.reapStaleDiagnoses(org.id);
      const started = await Promise.all(
        pages.map(
          async (
            pageType,
          ): Promise<
            StartedDiagnosis & { error: string | null; run: string | null }
          > => {
            const alreadyRunning = (running: UxDiagnosis) => ({
              page_type: pageType,
              diagnosis_id: running.id,
              already_running: true,
              error: null,
              run: running.site_run_id ?? running.id,
            });
            const running = await store.fetchRunningDiagnosis(org.id, pageType);
            if (running) return alreadyRunning(running);
            // The real lock: only written if nobody started the page since.
            const diagnosis = await store.insertDiagnosisIfIdle(org.id, {
              domain: profile.domain,
              page_type: pageType,
              site_run_id: siteRunId,
              ...goal,
            });
            if (!diagnosis) {
              const winner = await store.fetchRunningDiagnosis(
                org.id,
                pageType,
              );
              if (winner) return alreadyRunning(winner);
              return {
                page_type: pageType,
                diagnosis_id: "",
                already_running: false,
                error:
                  "outra análise desta página começou e terminou agora: tente de novo",
                run: null,
              };
            }
            const base = {
              page_type: pageType,
              diagnosis_id: diagnosis.id,
              already_running: false,
              run: siteRunId,
            };
            try {
              await startUxDiagnosisWorkflow({
                diagnosisId: diagnosis.id,
                orgId: org.id,
                userId,
              });
            } catch (err) {
              await store.updateDiagnosis(org.id, diagnosis.id, {
                status: "error",
                error: `o workflow não começou: ${errorOf(err)}`,
                finished: true,
              });
              return { ...base, error: errorOf(err) };
            }
            return { ...base, error: null };
          },
        ),
      );
      const ok = started.filter((d) => !d.error);
      const first = ok[0];
      if (!first) {
        return {
          status: "error",
          error: started.map((d) => `${d.page_type}: ${d.error}`).join("; "),
        };
      }
      // Everything was already running: the run is the existing one.
      const fresh = ok.some((d) => !d.already_running);
      return {
        status: "started",
        site_run_id: fresh ? siteRunId : (first.run ?? siteRunId),
        diagnoses: ok.map(({ page_type, diagnosis_id, already_running }) => ({
          page_type,
          diagnosis_id,
          already_running,
        })),
      };
    } catch (err) {
      return { status: "error", error: errorOf(err) };
    }
  },
});

const VerifyOutputSchema = z.union([
  z.object({
    status: z.literal("running"),
    diagnosis_id: z.string(),
    instance_id: z.string(),
    hypotheses: z.number(),
    skipped: z.number(),
    skipped_note: z.string().optional(),
    repo_snapshot: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    error: z.string(),
    running_diagnosis_id: z.string().optional(),
  }),
]);

/** What the code tests read this round, said for the tool's answer. */
function repoSnapshotNote(
  diagnosis: UxDiagnosis,
  profile: Parameters<typeof codeAccessFor>[0],
): string {
  const fallback = diagnosis.evidence?.repo_snapshot_key
    ? "vale o snapshot da rodada"
    : "os testes de código saem 'não deu pra testar'";
  return `${codeAccessFor(profile).gap.error}: ${fallback}`;
}

export const PLAN_UX_HYPOTHESES_VERIFY = defineTool({
  name: "PLAN_UX_HYPOTHESES_VERIFY",
  description:
    "Verifica de novo as hipóteses de um diagnóstico de UI/UX que já existe (todas, ou só `hypothesis_id`): testa na loja no ar e no código, reescreve ou tira o que a prova desmente. Só pega hipótese pendente e sem 'ver no código' (aprovada, descartada ou com código fica como está; `skipped` diz quantas). Volta na hora; acompanhe com PLAN_UX_DIAGNOSIS_GET.",
  annotations: {
    title: "Verify Store Diagnosis Hypotheses",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    diagnosis_id: z.string().min(1).max(128),
    hypothesis_id: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Só esta hipótese. Ausente = todas as propostas"),
  }),
  outputSchema: VerifyOutputSchema,
  requiresAiBudget: true,
  handler: async (input, ctx): Promise<z.infer<typeof VerifyOutputSchema>> => {
    const org = await engineOrg(ctx);
    const userId = principalOf(ctx);
    const store = ctx.storage.planEngine;
    const diagnosisId = input.diagnosis_id;
    try {
      const diagnosis = await store.getDiagnosis(org.id, diagnosisId);
      if (!diagnosis) {
        return { status: "error", error: "diagnóstico não encontrado" };
      }
      if (diagnosis.status === "running") {
        return {
          status: "error",
          error: "o diagnóstico ainda está rodando: espere ele terminar",
        };
      }
      if (!diagnosis.evidence) {
        return {
          status: "error",
          error: "o diagnóstico não tem evidências (a coleta não terminou)",
        };
      }
      const [opportunities, hypotheses, profile] = await Promise.all([
        store.listOpportunities(org.id, diagnosisId),
        store.listHypotheses(org.id, diagnosisId),
        store.getSiteProfile(org.id),
      ]);
      const onScreen = new Set(opportunities.map((o) => o.id));
      const proposals = hypotheses.filter(
        (h) =>
          h.kind === "proposta" &&
          h.opportunity_id !== null &&
          onScreen.has(h.opportunity_id),
      );
      let only: string[];
      if (input.hypothesis_id) {
        const h = hypotheses.find((x) => x.id === input.hypothesis_id);
        if (!h) {
          return {
            status: "error",
            error: "hipótese não encontrada neste diagnóstico",
          };
        }
        if (!proposals.includes(h)) {
          return {
            status: "error",
            error:
              "só as propostas de uma oportunidade da tela são verificadas",
          };
        }
        const blocked = reverifyBlock(h);
        if (blocked) return { status: "error", error: blocked };
        only = [h.id];
      } else {
        // Approved, dismissed or "see in code" stay: verification may rewrite them.
        only = proposals.filter((h) => !reverifyBlock(h)).map((h) => h.id);
      }
      const skipped = input.hypothesis_id ? 0 : proposals.length - only.length;
      if (only.length === 0) {
        return {
          status: "error",
          error:
            skipped > 0
              ? `nenhuma hipótese pendente pra verificar: ${skipped} aprovada(s), descartada(s) ou com 'ver no código' ficam como estão`
              : "o diagnóstico não tem hipóteses pra verificar",
        };
      }

      await store.reapStaleDiagnoses(org.id);
      // The lock is per page: a whole-site run keeps the other pages running.
      const running = await store.fetchRunningDiagnosis(
        org.id,
        diagnosis.page_type,
      );
      if (running) {
        return {
          status: "error",
          error:
            running.id === diagnosisId
              ? "o diagnóstico ainda está rodando: espere ele terminar"
              : "outro diagnóstico desta página está rodando: espere ele terminar",
          running_diagnosis_id: running.id,
        };
      }
      if (!(await store.claimDiagnosisForVerify(org.id, diagnosisId))) {
        return {
          status: "error",
          error:
            "outra verificação ou análise começou agora: espere ela terminar",
        };
      }
      const repoNote = repoSnapshotNote(diagnosis, profile);
      // Each click is a new verification; the tag also separates its spend.
      const runTag = `reverify-${Date.now()}`;
      let instanceId: string;
      try {
        instanceId = await startUxDiagnosisWorkflow({
          diagnosisId,
          orgId: org.id,
          userId,
          phase: "verify",
          only,
          runTag,
          priorCost: diagnosis.cost_usd ?? 0,
        });
      } catch (err) {
        // Back as it was: verification never started.
        await store.updateDiagnosis(org.id, diagnosisId, {
          status: diagnosis.status,
          stage: diagnosis.stage,
          progress_note: null,
          error: diagnosis.error,
        });
        return {
          status: "error",
          error: `o workflow não começou: ${errorOf(err)}`,
        };
      }
      return {
        status: "running",
        diagnosis_id: diagnosisId,
        instance_id: instanceId,
        hypotheses: only.length,
        skipped,
        ...(skipped > 0
          ? {
              skipped_note: `${skipped} hipótese(s) aprovada(s), descartada(s) ou com 'ver no código' não foram verificadas de novo: a verificação pode reescrever ou apagar`,
            }
          : {}),
        repo_snapshot: repoNote,
      };
    } catch (err) {
      return { status: "error", error: errorOf(err) };
    }
  },
});
