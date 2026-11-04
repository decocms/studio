/** Partner services: a branded skill the agent runs on the project, offered by
 *  the partner. Hiring one files an epic plus a kickoff card for the Super
 *  Agent, which plans the rest of the epic and executes it.
 *
 *  ponytail: a static list while the idea is tested; move to the registry when
 *  partners publish their own. */

import type { TranslationKey } from "@/i18n/use-t.ts";

export interface ServiceField {
  id: string;
  labelKey: TranslationKey;
  /** Stored as an organization secret; the card names the secret, never the value. */
  secret?: boolean;
  optional?: boolean;
}

export interface PartnerService {
  id: string;
  partner: string;
  nameKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** BRL. */
  listPrice: number;
  price: number;
  fields: ServiceField[];
  /** What the agent does, in order — the kickoff card turns these into cards. */
  steps: string[];
}

export const PARTNER_SERVICES: PartnerService[] = [
  {
    id: "synerise-semantic-search",
    partner: "Synerise",
    nameKey: "services.synerise.name",
    descriptionKey: "services.synerise.description",
    listPrice: 5000,
    price: 0,
    fields: [
      { id: "workspace", labelKey: "services.synerise.workspace" },
      { id: "api_key", labelKey: "services.synerise.apiKey", secret: true },
    ],
    steps: [
      "Audit the site's current search: provider, search page, autocomplete, and how results are rendered.",
      "Sync the product catalog to Synerise (feed or API) so it can be indexed for semantic search.",
      "Replace the search loader and autocomplete with Synerise semantic search, keeping the existing UI.",
      "Track search events (query, click, add to cart) to Synerise so ranking learns from behavior.",
      "Validate relevance on the site's top queries against the old search and report the comparison.",
    ],
  },
  {
    id: "abacatepay-gateway-migration",
    partner: "AbacatePay",
    nameKey: "services.abacatepay.name",
    descriptionKey: "services.abacatepay.description",
    listPrice: 500,
    price: 0,
    fields: [
      { id: "api_key", labelKey: "services.abacatepay.apiKey", secret: true },
      {
        id: "current_gateway",
        labelKey: "services.abacatepay.currentGateway",
        optional: true,
      },
    ],
    steps: [
      "Map the current payment gateway integration: checkout flow, payment methods, webhooks, and refunds.",
      "Integrate AbacatePay (Pix and card) in the checkout behind the same payment interface.",
      "Handle AbacatePay webhooks to update order status.",
      "Test the full purchase flow in AbacatePay's dev mode, then document the switch-over steps.",
    ],
  },
];

export function kickoffDescription(
  service: PartnerService,
  answers: Record<string, string>,
): string {
  const inputs = service.fields
    .filter((field) => answers[field.id])
    .map((field) =>
      field.secret
        ? `- ${field.id}: stored in the organization secret \`${answers[field.id]}\``
        : `- ${field.id}: ${answers[field.id]}`,
    );
  return [
    `This project hired the **${service.id}** service, offered by ${service.partner}.`,
    "",
    "You own its epic (this card's parent). Plan it, then execute it:",
    "1. File one card under this card's epic (same parent, same project) for each step below, splitting or merging steps where the site calls for it.",
    "2. Work the cards in order, one pull request each.",
    "3. When a step needs something you don't have (a credential, an access, a decision), ask in a comment on its card instead of guessing.",
    "",
    "Steps:",
    ...service.steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "What the customer gave at onboarding:",
    ...(inputs.length ? inputs : ["- nothing"]),
  ].join("\n");
}
