/**
 * What only the customer can give the analysis: the store's domain, the
 * competitors to compare with, Deco Analytics, the GA4 export, the store's
 * orders and the site's repository. The engine names what is missing; the analysis runs without all
 * but the domain, so this card asks without blocking anything.
 */

import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { CompetitorsRow } from "./competitors-field.tsx";
import { ConnectCard } from "./connect-card.tsx";
import type { SetupKey, SetupNeed } from "./diagnosis-schema.ts";
import { StoreDomainForm, useCanEditSetup } from "./store-domain.tsx";

/** Where a gap the customer closes links to. */
export const SETUP_CARD_ID = "plan-setup";

function Need({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-foreground">{text}</p>
      {children}
    </div>
  );
}

/** Opens the BigQuery setup in place; it rebinds the engine's connection
 *  and dataset. */
function BigQueryNeed() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex w-full flex-col items-start gap-2">
      <p className="text-sm text-foreground">
        {t("plan.opportunities.setup.bigquery")}
      </p>
      {open ? (
        <div className="w-full">
          <ConnectCard />
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t("plan.opportunities.setup.bigqueryAction")}
        </Button>
      )}
    </div>
  );
}

function NeedBlock({
  need,
  competitors,
}: {
  need: SetupNeed & { key: SetupKey };
  competitors: string[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  switch (need.key) {
    case "domain":
      return (
        <div className="max-w-md">
          <StoreDomainForm />
        </div>
      );
    case "competitors":
      return <CompetitorsRow list={need.suggested ?? competitors} suggested />;
    case "analytics_install":
      return (
        <Need text={t("plan.opportunities.setup.analytics")}>
          <Button asChild variant="outline" size="sm">
            <Link
              to="/$org/monitoring"
              params={{ org: org.slug }}
              search={{ view: "analytics" }}
            >
              {t("plan.opportunities.setup.analyticsAction")}
            </Link>
          </Button>
        </Need>
      );
    case "bigquery":
      return <BigQueryNeed />;
    case "orders":
      return (
        <Need text={t("plan.opportunities.setup.orders")}>
          <Button asChild variant="outline" size="sm">
            <Link
              to="/$org/settings/connections"
              params={{ org: org.slug }}
              search={{ tab: "all" as const }}
            >
              {t("plan.opportunities.setup.ordersAction")}
            </Link>
          </Button>
        </Need>
      );
    case "repository":
      return (
        <Need text={t("plan.opportunities.setup.repository")}>
          <Button asChild variant="outline" size="sm">
            <Link to="/$org/settings/repositories" params={{ org: org.slug }}>
              {t("plan.opportunities.setup.repositoryAction")}
            </Link>
          </Button>
        </Need>
      );
  }
}

/** One block per need. `competitors` is the profile's list, the start of
 *  the form when the engine has no suggestion. Editing follows the same
 *  permission as the store's domain. */
export function SetupCard({
  needs,
  competitors,
}: {
  needs: (SetupNeed & { key: SetupKey })[];
  competitors: string[];
}) {
  const t = useT();
  const canEdit = useCanEditSetup();
  return (
    <Card id={SETUP_CARD_ID} className="scroll-mt-4 gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">
          {t("plan.opportunities.setup.heading")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.setup.description")}
        </p>
      </div>
      {canEdit === false && (
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.setup.askAdmin")}
        </p>
      )}
      {canEdit && (
        <ul className="flex flex-col gap-4">
          {needs.map((need) => (
            <li
              key={need.key}
              className="border-t border-border pt-4 first:border-t-0 first:pt-0"
            >
              <NeedBlock need={need} competitors={competitors} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
