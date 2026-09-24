import { useState } from "react";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { useT } from "@/i18n/use-t.ts";
import {
  type Experiment,
  type ExperimentStatus,
  useCreateExperiment,
  useDeleteExperiment,
  useExperimentResults,
  useExperiments,
  useUpdateExperiment,
} from "@/hooks/use-experiments";

const STATUSES: ExperimentStatus[] = ["draft", "running", "paused", "ended"];

interface VariantForm {
  id: string;
  weight: string;
  role: "" | "control" | "treatment";
}

const BLANK_VARIANTS: VariantForm[] = [
  { id: "control", weight: "50", role: "control" },
  { id: "variant-b", weight: "50", role: "treatment" },
];

function Variants({ variants }: { variants: Experiment["variants"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {variants.map((v) => (
        <span
          key={v.id}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {v.id} {v.weight}%
        </span>
      ))}
    </div>
  );
}

function CreateDialog({
  site,
  open,
  onOpenChange,
}: {
  site: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const create = useCreateExperiment(site);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [variants, setVariants] = useState<VariantForm[]>(BLANK_VARIANTS);

  const sum = variants.reduce((a, v) => a + (Number(v.weight) || 0), 0);
  const setVar = (i: number, patch: Partial<VariantForm>) =>
    setVariants((vs) =>
      vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)),
    );

  const submit = () => {
    create.mutate(
      {
        key: key.trim(),
        name: name.trim(),
        variants: variants.map((v) => ({
          id: v.id.trim(),
          weight: Number(v.weight) || 0,
          role: v.role || null,
        })),
      },
      {
        onSuccess: () => {
          setKey("");
          setName("");
          setVariants(BLANK_VARIANTS);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("experiments.dialog.newTitle")}</DialogTitle>
          <DialogDescription>{t("experiments.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t("experiments.dialog.key")}</Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="plp-ranking"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t("experiments.dialog.name")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="PLP ranking"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                {t("experiments.dialog.variants")} —{" "}
                {t("experiments.dialog.weightSum", { sum })}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setVariants((vs) => [
                    ...vs,
                    { id: "", weight: "0", role: "" },
                  ])
                }
              >
                {t("experiments.dialog.addVariant")}
              </Button>
            </div>
            {variants.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional editable rows
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={v.id}
                  onChange={(e) => setVar(i, { id: e.target.value })}
                  placeholder="id"
                  className="h-8 flex-1"
                />
                <Input
                  value={v.weight}
                  onChange={(e) => setVar(i, { weight: e.target.value })}
                  inputMode="numeric"
                  className="h-8 w-16"
                />
                <select
                  value={v.role}
                  onChange={(e) =>
                    setVar(i, { role: e.target.value as VariantForm["role"] })
                  }
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                >
                  <option value="">role…</option>
                  <option value="control">control</option>
                  <option value="treatment">treatment</option>
                </select>
              </div>
            ))}
          </div>
          {create.error && (
            <p className="text-xs text-destructive">
              {create.error instanceof Error ? create.error.message : "Error"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("experiments.dialog.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending || !key.trim() || !name.trim()}
          >
            {t("experiments.dialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => new Intl.NumberFormat().format(n);

function Results({
  site,
  experimentKey,
}: {
  site: string;
  experimentKey: string;
}) {
  const t = useT();
  const { data, isLoading } = useExperimentResults(site, experimentKey);

  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }

  if (!data?.available) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        {data?.reason === "no_site_data"
          ? t("experiments.results.noSiteData", { site: data.analyticsSite })
          : t("experiments.results.unavailable")}
      </div>
    );
  }

  const r = data.results;
  if (!r || r.stats.totalParticipants === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        {t("experiments.results.empty")}
      </div>
    );
  }

  const conversionGoals = r.goals.filter((g) => g.goal !== "visitors");

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 sm:grid-cols-4">
        <Stat
          label={t("experiments.results.participants")}
          value={num(r.stats.totalParticipants)}
        />
        <Stat
          label={t("experiments.results.sampleSize")}
          value={num(r.stats.sampleSize)}
        />
        <Stat
          label={`${t("experiments.results.control")} · ${t("experiments.results.visitors")}`}
          value={num(r.visitors.default)}
        />
        <Stat
          label={`${t("experiments.results.variant")} · ${t("experiments.results.visitors")}`}
          value={num(r.visitors.variant)}
        />
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-1 text-xs text-muted-foreground">
          {t("experiments.results.probBest")}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm">
            {t("experiments.results.variant")}:{" "}
            <span className="font-semibold tabular-nums">
              {pct(r.stats.probabilityVariantBest)}
            </span>
          </span>
          <span className="text-sm text-muted-foreground">
            {t("experiments.results.control")}:{" "}
            <span className="font-semibold tabular-nums">
              {pct(r.stats.probabilityDefaultBest)}
            </span>
          </span>
        </div>
      </div>

      {conversionGoals.length > 0 && (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("experiments.results.goal")}</TableHead>
                <TableHead className="text-right">
                  {t("experiments.results.control")}
                </TableHead>
                <TableHead className="text-right">
                  {t("experiments.results.variant")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversionGoals.map((g) => (
                <TableRow key={g.goal}>
                  <TableCell>{g.goal}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(g.default)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(g.variant)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Detail({
  site,
  experiment,
  onBack,
}: {
  site: string;
  experiment: Experiment;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ←
        </Button>
        <span className="text-lg font-semibold">{experiment.name}</span>
        <Badge>{experiment.status}</Badge>
      </div>
      <div className="rounded-lg border border-border p-4">
        <div className="mb-2 text-xs text-muted-foreground">
          {t("experiments.col.variants")}
        </div>
        <Variants variants={experiment.variants} />
      </div>
      <div className="text-sm font-semibold">
        {t("experiments.results.title")}
      </div>
      <Results site={site} experimentKey={experiment.key} />
    </div>
  );
}

export function ExperimentsTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: experiments, isLoading } = useExperiments(siteSlug ?? "");
  const update = useUpdateExperiment(siteSlug ?? "");
  const del = useDeleteExperiment(siteSlug ?? "");

  if (!siteSlug) {
    return (
      <div className="p-8">
        <EmptyState
          title={t("experiments.title")}
          description={t("experiments.noSite")}
        />
      </div>
    );
  }

  const selected = experiments?.find((e) => e.key === selectedKey) ?? null;
  if (selected) {
    return (
      <Detail
        site={siteSlug}
        experiment={selected}
        onBack={() => setSelectedKey(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("experiments.title")}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("experiments.subtitle")}
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          {t("experiments.new")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Spinner />
        </div>
      ) : !experiments || experiments.length === 0 ? (
        <EmptyState
          title={t("experiments.empty.title")}
          description={t("experiments.empty.desc")}
          buttonProps={{
            children: t("experiments.new"),
            onClick: () => setDialogOpen(true),
          }}
        />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("experiments.col.name")}</TableHead>
                <TableHead>{t("experiments.col.key")}</TableHead>
                <TableHead>{t("experiments.col.status")}</TableHead>
                <TableHead>{t("experiments.col.variants")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiments.map((e) => (
                <TableRow key={e.key}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-sm underline-offset-4 hover:underline"
                      onClick={() => setSelectedKey(e.key)}
                    >
                      {e.name}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.key}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={e.status}
                      onValueChange={(v) =>
                        update.mutate({
                          key: e.key,
                          status: v as ExperimentStatus,
                        })
                      }
                    >
                      <SelectTrigger className="h-8 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Variants variants={e.variants} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (
                          window.confirm(
                            t("experiments.deleteConfirm", { key: e.key }),
                          )
                        ) {
                          del.mutate(e.key);
                        }
                      }}
                    >
                      {t("experiments.action.delete")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateDialog
        site={siteSlug}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
