/**
 * The store analysis is not connected yet: pick the organization's BigQuery
 * connection and the dataset of the store's GA4 export, and set it up with
 * `PLAN_DIAGNOSIS_SETUP`. Without a BigQuery connection, point to where
 * connections are added.
 */

import { Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { useCapability } from "@/hooks/use-capability";
import { useT } from "@/i18n/use-t.ts";
import { useConnections, useProjectContext } from "@/sdk";
import { errorText } from "./opportunity-view.ts";
import { useDiagnosisSetup } from "./use-plan-diagnosis.ts";

/** What the engine calls on the BigQuery connection it is bound to. */
const BIGQUERY_BINDING = [{ name: "bigquery_query" }];

function SetupForm() {
  const t = useT();
  const { org } = useProjectContext();
  const connections = useConnections({ binding: BIGQUERY_BINDING });
  const setup = useDiagnosisSetup();
  const [picked, setPicked] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const connectionId = picked ?? connections[0]?.id ?? "";

  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.connect.noBigQuery")}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link
            to="/$org/settings/connections"
            params={{ org: org.slug }}
            search={{ tab: "all" as const }}
          >
            {t("plan.opportunities.connect.addConnection")}
          </Link>
        </Button>
      </div>
    );
  }

  const project = projectId.trim();
  const dataset = datasetId.trim();
  const canSubmit =
    connectionId !== "" && project !== "" && dataset !== "" && !setup.isPending;
  const failure = setup.isError ? errorText(setup.error) : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setup.mutate({
          bigquery_connection_id: connectionId,
          bigquery_project_id: project,
          bigquery_dataset_id: dataset,
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="plan-diagnosis-connection">
            {t("plan.opportunities.connect.connection")}
          </Label>
          <Select value={connectionId} onValueChange={setPicked}>
            <SelectTrigger id="plan-diagnosis-connection" className="w-full">
              <SelectValue
                placeholder={t(
                  "plan.opportunities.connect.connectionPlaceholder",
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="plan-diagnosis-project">
            {t("plan.opportunities.connect.project")}
          </Label>
          <Input
            id="plan-diagnosis-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder={t("plan.opportunities.connect.projectPlaceholder")}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="plan-diagnosis-dataset">
            {t("plan.opportunities.connect.dataset")}
          </Label>
          <Input
            id="plan-diagnosis-dataset"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder={t("plan.opportunities.connect.datasetPlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>
      {setup.isError && (
        <div className="flex flex-col gap-0.5 text-sm" role="alert">
          <span className="text-destructive">
            {t("plan.opportunities.connect.failed")}
          </span>
          {failure && (
            <span className="text-xs text-muted-foreground">{failure}</span>
          )}
        </div>
      )}
      <Button type="submit" className="self-start" disabled={!canSubmit}>
        {t("plan.opportunities.connect.submit")}
      </Button>
    </form>
  );
}

/** Setup creates an org connection, so only a member who manages connections
 *  sees the form; if capabilities fail to load, the server decides. */
function SetupGate() {
  const t = useT();
  const capability = useCapability("connections:manage");
  if (capability.loading) return <Skeleton className="h-24 w-full" />;
  if (!capability.granted && !capability.error) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("plan.opportunities.connect.askAdmin")}
      </p>
    );
  }
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <SetupForm />
    </Suspense>
  );
}

export function ConnectCard() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.opportunities.connect.eyebrow")}
        </p>
        <h2 className="text-xl font-medium text-foreground">
          {t("plan.opportunities.connect.heading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.connect.description")}
        </p>
      </div>
      <Card>
        <ErrorBoundary
          fallback={({ error }) => (
            <div className="flex flex-col gap-0.5 text-sm" role="alert">
              <span className="text-destructive">
                {t("plan.opportunities.connect.loadFailed")}
              </span>
              {errorText(error) && (
                <span className="text-xs text-muted-foreground">
                  {errorText(error)}
                </span>
              )}
            </div>
          )}
        >
          <SetupGate />
        </ErrorBoundary>
      </Card>
    </div>
  );
}
