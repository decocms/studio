/**
 * Contrato do verificador de hipóteses: o modelo só monta passos da lista fixa
 * abaixo e aponta alvos nossos (elemento da Deco Analytics ou parte da página),
 * nunca escreve código pro navegador nem seletor livre.
 */

import type { UxPart } from "../types.ts";

export type VerifyTarget =
  | { kind: "element"; key: string } // "root|el" da Deco Analytics
  | {
      kind: "part";
      /** Uma parte medida no tipo de página analisado (page-types.ts). */
      part: UxPart;
    };

export type VerifyStep =
  /**
   * `keep_overlays`: abre (ou recarrega) sem fechar pop-up/modal/banner. Sem
   * isso, a hipótese sobre o pop-up media o pop-up já fechado (div 0×0, numa
   * loja em 13/11).
   */
  | { op: "open"; keep_overlays?: boolean }
  | { op: "reload"; keep_overlays?: boolean }
  | { op: "choose_size" }
  | { op: "choose_variant" }
  /**
   * Mexe o mouse no miolo da tela, sem clicar nem tocar. O pop-up de
   * newsletter de uma loja só abre no primeiro mousemove/touchmove, e o
   * navegador do teste nunca mexia (14/11).
   */
  | { op: "gesture" }
  | { op: "wait"; ms: number }
  | {
      op: "click" | "scroll_to" | "inspect" | "observe_click" | "screenshot";
      target: VerifyTarget;
    };

export interface VerifyCheck {
  /** "c1".."c4"; "c1-f" é o teste que o repo pediu pro navegador. */
  id: string;
  claim: string;
  /** "data": conferido só nos dados do diagnóstico (data-checks.ts). */
  stage: "live" | "repo" | "data";
  device: "mobile" | "desktop";
  /** Vazio em "repo". */
  steps: VerifyStep[];
  /** Só "repo". */
  question: string | null;
  confirms_if: string;
  refutes_if: string;
}

export type CheckOutcome =
  | "confirma"
  | "desmente"
  | "nao_decidiu"
  | "nao_testou";

export interface CheckRun {
  check: VerifyCheck;
  outcome: CheckOutcome;
  /** O que se viu, em português, com números/estilos. */
  observed: string;
  screenshot_url: string | null;
  /** "src/sections/Product/ProductDetails.tsx:88" no repo. */
  source_ref: string | null;
  /**
   * false = o juiz disse que este teste não mede a causa (mede o sintoma, outra
   * parte): não conta no veredito nem nos níveis de validação. Ausente = conta.
   */
  measures_cause?: boolean;
}

export type Verdict =
  | "confirmada"
  | "desmentida"
  | "reescrita"
  | "inconclusiva";

export interface HypothesisVerification {
  verdict: Verdict;
  /** Uma linha, cita o teste que decidiu. */
  summary: string;
  runs: CheckRun[];
  rewritten_from: { title: string; why: string } | null;
  verified_at: string;
  /**
   * A confiança antes de qualquer verificação. "Verificar de novo" parte
   * dela: senão cada confirmação somaria o bônus outra vez. Ausente nas
   * gravadas antes de 13/11 à noite.
   */
  base_confidence?: number;
  /**
   * Desmentida: as linhas de investigação que a prova abre ("se o botão está
   * visível, olhar o que acontece depois do clique"). Ausente = nenhuma.
   */
  novas_linhas?: string[];
}

const VERDICTS: readonly string[] = [
  "confirmada",
  "desmentida",
  "reescrita",
  "inconclusiva",
];

export function encodeVerification(
  v: HypothesisVerification | null,
): string | null {
  return v ? JSON.stringify(v) : null;
}

/** JSON inválido ou fora do formato vira null: a hipótese segue sem selo. */
export function decodeVerification(
  raw: unknown,
): HypothesisVerification | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HypothesisVerification> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.verdict !== "string" ||
      !VERDICTS.includes(parsed.verdict) ||
      !Array.isArray(parsed.runs)
    ) {
      return null;
    }
    const { base_confidence, ...rest } = parsed as HypothesisVerification;
    return typeof base_confidence === "number" &&
      Number.isFinite(base_confidence)
      ? { ...rest, base_confidence }
      : rest;
  } catch {
    return null;
  }
}
