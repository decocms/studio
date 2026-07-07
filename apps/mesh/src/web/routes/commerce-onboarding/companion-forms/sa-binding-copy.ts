// Copy + step-by-step guidance for the shared-SA binding flow (the consent-free
// lane). Pure data/functions so the instructions are unit-testable and the form
// stays presentational. The whole point: tell the user EXACTLY what to do —
// both to grant access up front and to fix a specific failure (e.g. a GA4
// property with no web data stream ⇒ no site URL to verify against).

export type BindProvider = "ga4" | "gsc";

/** The shared service account the client grants access to — never a human
 *  account (no consent screen, no god-login to protect). */
export const SA_EMAIL = "deco-reader@decocms.iam.gserviceaccount.com";

/** commerce-discovery binding requirement types → provider codes. Only these
 *  two use the shared-SA lane; VTEX keeps its own credential flow. */
export const PROVIDER_BY_BINDING_TYPE: Record<string, BindProvider> = {
  "google-analytics": "ga4",
  "google-search-console": "gsc",
};

export interface BindProviderCopy {
  /** Human label, e.g. "Google Analytics". */
  label: string;
  /** Field label for the id the user pastes. */
  resourceLabel: string;
  resourcePlaceholder: string;
  /** Where to find that id. */
  resourceHint: string;
  /** Ordered steps to grant the SA access + locate the id. */
  connectSteps: string[];
}

export const BIND_PROVIDER_COPY: Record<BindProvider, BindProviderCopy> = {
  ga4: {
    label: "Google Analytics",
    resourceLabel: "ID da propriedade",
    resourcePlaceholder: "ex: 123456789",
    resourceHint:
      "No GA4: Admin → Detalhes da propriedade → ID da propriedade (só números).",
    connectSteps: [
      "Abra o Google Analytics (GA4) da sua loja.",
      "Vá em Admin → Acesso à propriedade (Gerenciamento de acesso).",
      `Clique em + → Adicionar usuários, cole ${SA_EMAIL} e conceda o papel Leitor.`,
      "Copie o ID da propriedade (Admin → Detalhes da propriedade) e cole abaixo.",
    ],
  },
  gsc: {
    label: "Google Search Console",
    resourceLabel: "Site / propriedade",
    resourcePlaceholder: "ex: sc-domain:sualoja.com.br",
    resourceHint:
      "Use o mesmo formato que aparece no Search Console: sc-domain:sualoja.com.br ou https://www.sualoja.com.br/.",
    connectSteps: [
      "Abra o Google Search Console da sua loja.",
      "Vá em Configurações → Usuários e permissões.",
      `Clique em Adicionar usuário, cole ${SA_EMAIL} e escolha permissão Completa.`,
      "Copie o endereço do site como aparece no seletor de propriedades e cole abaixo.",
    ],
  },
};

export interface RemediationCopy {
  title: string;
  steps: string[];
}

/**
 * Map a bind failure `reason` to concrete, provider-specific next steps. The
 * backend already returns a one-line pt-BR `detail`; this turns each failure
 * into an actionable checklist the form renders inline. `no-web-stream` is the
 * "site URL missing on GA" case — the property has no web data stream to verify
 * the domain against, so we walk the user through creating one.
 */
export function remediationFor(
  provider: BindProvider,
  reason: string,
): RemediationCopy {
  const label = BIND_PROVIDER_COPY[provider].label;
  switch (reason) {
    case "no-access":
      return {
        title: `Ainda não conseguimos acessar este recurso no ${label}.`,
        steps:
          provider === "ga4"
            ? [
                `Confirme que ${SA_EMAIL} foi adicionado em Admin → Acesso à propriedade com o papel Leitor.`,
                "Confira se o ID da propriedade está correto (só números, sem o prefixo 'properties/').",
                "A concessão de acesso pode levar alguns segundos — tente novamente.",
              ]
            : [
                `Confirme que ${SA_EMAIL} foi adicionado em Configurações → Usuários e permissões.`,
                "A permissão precisa ser Completa ou Restrita — 'Não verificado' não funciona.",
                "Confira se o endereço do site está exatamente como aparece no Search Console.",
              ],
      };
    case "no-web-stream":
      // GA4-specific: the property measures no website, so there's no defaultUri
      // (site URL) to check ownership against.
      return {
        title:
          "Esta propriedade do GA4 não tem um fluxo de dados da Web (site) configurado.",
        steps: [
          "No GA4, vá em Admin → Fluxos de dados.",
          "Clique em Adicionar fluxo → Web.",
          "Informe a URL do site da sua loja e salve o fluxo.",
          "Volte aqui e tente vincular de novo. (Propriedades só de app precisam de vínculo manual — fale com o suporte.)",
        ],
      };
    case "no-match":
      return {
        title: `O recurso informado não corresponde ao domínio desta loja.`,
        steps:
          provider === "ga4"
            ? [
                "Verifique se digitou o ID da propriedade certa — provavelmente é de outro site.",
                "No GA4, o site medido aparece em Admin → Fluxos de dados → (seu fluxo Web) → URL do stream.",
              ]
            : [
                "Verifique se selecionou a propriedade do Search Console referente a esta loja.",
                "O endereço precisa cobrir o mesmo domínio do diagnóstico.",
              ],
      };
    case "resource_already_bound":
      return {
        title: "Este recurso já está vinculado a outra loja.",
        steps: [
          "Se este recurso é realmente desta loja, fale com o suporte para uma revisão manual.",
          "Caso tenha digitado o id errado, confira e tente novamente.",
        ],
      };
    default:
      return {
        title: "Não foi possível verificar o acesso a este recurso.",
        steps: [
          "Revise os passos de acesso acima e tente novamente.",
          "Se persistir, fale com o suporte.",
        ],
      };
  }
}
