import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  CodeBrowser,
  Eye,
  Pencil01,
  Stars02,
  Trash01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
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
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { useT } from "@/i18n/use-t.ts";
import {
  type Experiment,
  type ExperimentStatus,
  type SuggestedExperiment,
  useCreateExperiment,
  useDeleteExperiment,
  useImplementExperiment,
  useImplementExperimentLocal,
  useExperiments,
  useSuggestExperiment,
  useSyncExperimentPreviewLocal,
  useUpdateExperiment,
} from "@/hooks/use-experiments";

const STATUSES: ExperimentStatus[] = ["draft", "running", "paused", "ended"];

/** Dot/pill colors per status — semantic, not the row's own accent (a variant
 *  split uses accent for "the non-control arm"; status is a different axis). */
const STATUS_STYLES: Record<ExperimentStatus, { dot: string; pill: string }> = {
  running: { dot: "bg-success", pill: "bg-success/10 text-success" },
  paused: { dot: "bg-warning", pill: "bg-warning/10 text-warning" },
  draft: {
    dot: "bg-muted-foreground/60",
    pill: "bg-muted text-muted-foreground",
  },
  ended: {
    dot: "bg-muted-foreground/40",
    pill: "bg-muted text-muted-foreground",
  },
};

/** One arm's color in the split bar: the control arm is always neutral, every
 *  other arm (however many) shares the one accent — the bar communicates
 *  shape (relative widths) and role, not a distinct hue per arm. */
function variantBarColor(role: string | null | undefined): string {
  return role === "control" ? "bg-muted-foreground/50" : "bg-primary";
}

interface VariantForm {
  id: string;
  weight: string;
  role: "" | "control" | "treatment";
  /** One sentence: what this arm specifically shows/does. From
   *  EXPERIMENT_SUGGEST, or typed manually — optional either way. */
  description?: string;
}

const BLANK_VARIANTS: VariantForm[] = [
  { id: "control", weight: "50", role: "control" },
  { id: "variant-b", weight: "50", role: "treatment" },
];

/** Proportional split bar + per-arm legend — the same visual for the list row
 *  and (once results ship to Deco Analytics) anywhere else a variant split
 *  needs to read at a glance. */
function SplitBar({ variants }: { variants: Experiment["variants"] }) {
  const total = variants.reduce((a, v) => a + v.weight, 0) || 100;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {variants.map((v) => (
          <div
            key={v.id}
            className={cn(variantBarColor(v.role))}
            style={{ width: `${(v.weight / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        {variants.map((v) => (
          <span
            key={v.id}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span
              className={cn("h-1.5 w-1.5 rounded-sm", variantBarColor(v.role))}
            />
            {v.id}{" "}
            <span className="font-mono text-muted-foreground/70">
              {v.weight}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Create AND edit share this form — an experiment's shape (key, name,
 * variants) is the same either way, only the mutation and whether `key` can
 * still move differ. `mode: "edit"` locks `key`: it's the identifier
 * `useExperiment(key)` and the deco-ab-testing Worker's test name key off —
 * changing it here would silently detach the row from the live test.
 */
function ExperimentDialog({
  site,
  open,
  onOpenChange,
  mode = "create",
  initialKey,
  initialName,
  initialVariants,
  hypothesis,
}: {
  site: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode?: "create" | "edit";
  /** Pre-fills the form — from `EXPERIMENT_SUGGEST`'s output in create mode,
   *  or the experiment being edited in edit mode. Pass a fresh object
   *  identity (or key this component by it) to reset the form. */
  initialKey?: string;
  initialName?: string;
  initialVariants?: VariantForm[];
  /** Shown above the form when the fields came from a prompt suggestion (create mode only). */
  hypothesis?: string;
}) {
  const t = useT();
  const create = useCreateExperiment(site);
  const update = useUpdateExperiment(site);
  const mutation = mode === "edit" ? update : create;
  const [key, setKey] = useState(initialKey ?? "");
  const [name, setName] = useState(initialName ?? "");
  const [variants, setVariants] = useState<VariantForm[]>(
    initialVariants ?? BLANK_VARIANTS,
  );

  const sum = variants.reduce((a, v) => a + (Number(v.weight) || 0), 0);
  const setVar = (i: number, patch: Partial<VariantForm>) =>
    setVariants((vs) =>
      vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)),
    );

  const submit = () => {
    const payload = {
      key: key.trim(),
      name: name.trim(),
      variants: variants.map((v) => ({
        id: v.id.trim(),
        weight: Number(v.weight) || 0,
        role: v.role || null,
        description: v.description || null,
      })),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        if (mode === "create") {
          setKey("");
          setName("");
          setVariants(BLANK_VARIANTS);
        }
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit"
              ? t("experiments.dialog.editTitle")
              : hypothesis
                ? t("experiments.prompt.reviewTitle")
                : t("experiments.dialog.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("experiments.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {hypothesis && (
            <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs">
              <span className="font-medium text-muted-foreground">
                {t("experiments.prompt.hypothesis")}:{" "}
              </span>
              {hypothesis}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t("experiments.dialog.key")}</Label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="valentine-banner"
                disabled={mode === "edit"}
                title={
                  mode === "edit"
                    ? t("experiments.dialog.keyLocked")
                    : undefined
                }
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
              <div key={i} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
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
                      setVar(i, {
                        role: e.target.value as VariantForm["role"],
                      })
                    }
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    <option value="">role…</option>
                    <option value="control">control</option>
                    <option value="treatment">treatment</option>
                  </select>
                </div>
                {/* The before/after: what this arm will actually do once
                    implemented — the text the Super Agent's run is scoped to. */}
                {v.description && (
                  <p className="pl-1 text-xs text-muted-foreground">
                    {v.description}
                  </p>
                )}
              </div>
            ))}
          </div>
          {mutation.error && (
            <p className="text-xs text-destructive">
              {mutation.error instanceof Error
                ? mutation.error.message
                : "Error"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("experiments.dialog.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={mutation.isPending || !key.trim() || !name.trim()}
          >
            {mode === "edit"
              ? t("experiments.dialog.save")
              : t("experiments.dialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "New experiment" entry point: a free-text prompt ("Valentine's Day
 * banner shows to 50% of users...") that `EXPERIMENT_SUGGEST` turns into a
 * structured proposal — the operator reviews and edits it in `ExperimentDialog`
 * before anything is created. Nothing here persists anything.
 */
function PromptDialog({
  site,
  open,
  onOpenChange,
  onGenerated,
}: {
  site: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called with the accepted proposal (or `null` for "write it manually")
   *  once the operator is ready to move to the review step. */
  onGenerated: (suggestion: SuggestedExperiment | null) => void;
}) {
  const t = useT();
  const suggest = useSuggestExperiment(site);
  const [prompt, setPrompt] = useState("");

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setPrompt("");
      suggest.reset();
    }
  };

  const generate = (text = prompt) => {
    if (!text.trim()) return;
    suggest.mutate(text.trim(), {
      onSuccess: (result) => {
        close(false);
        onGenerated(result);
      },
    });
  };

  const examples = [
    t("experiments.prompt.example1"),
    t("experiments.prompt.example2"),
    t("experiments.prompt.example3"),
  ];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Stars02 size={18} />
            </div>
            <div className="flex flex-col gap-0.5">
              <DialogTitle>{t("experiments.prompt.title")}</DialogTitle>
              <DialogDescription>
                {t("experiments.prompt.subtitle")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("experiments.prompt.placeholder")}
            rows={4}
            autoFocus
            className="resize-none"
          />

          <div className="flex flex-wrap gap-1.5">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t("experiments.prompt.willGenerate")}
          </p>

          {suggest.error && (
            <p className="text-xs text-destructive">
              {suggest.error instanceof Error ? suggest.error.message : "Error"}
            </p>
          )}
        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              close(false);
              onGenerated(null);
            }}
          >
            {t("experiments.prompt.editManually")}
          </Button>
          <Button
            onClick={() => generate()}
            disabled={suggest.isPending || !prompt.trim()}
            className="gap-1.5"
          >
            {suggest.isPending ? (
              <>
                <Spinner size="2xs" />
                {t("experiments.prompt.generating")}
              </>
            ) : (
              <>
                <Stars02 size={14} />
                {t("experiments.prompt.generate")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryStrip({ experiments }: { experiments: Experiment[] }) {
  const t = useT();
  const counts = {
    running: experiments.filter((e) => e.status === "running").length,
    paused: experiments.filter((e) => e.status === "paused").length,
    draft: experiments.filter((e) => e.status === "draft").length,
  };
  return (
    <div className="flex gap-6 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-xl font-semibold tabular-nums">
          {experiments.length}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("experiments.summary.total")}
        </span>
      </div>
      <div className="w-px bg-border" />
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xl font-semibold tabular-nums text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {counts.running}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("experiments.status.running")}
        </span>
      </div>
      <div className="w-px bg-border" />
      <div className="flex flex-col gap-0.5">
        <span className="text-xl font-semibold tabular-nums text-muted-foreground">
          {counts.paused}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("experiments.status.paused")}
        </span>
      </div>
      <div className="w-px bg-border" />
      <div className="flex flex-col gap-0.5">
        <span className="text-xl font-semibold tabular-nums text-muted-foreground">
          {counts.draft}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("experiments.status.draft")}
        </span>
      </div>
    </div>
  );
}

/** Appends the SDK's forced-variant query param (the same `?__ab=test:arm`
 *  QA override `useExperiment`'s own doc comment mentions) to a preview URL
 *  — lets a single site render as any one variant, no real assignment
 *  needed. Falls back to the raw base URL if it isn't a valid absolute URL. */
function buildForcedVariantUrl(
  baseUrl: string,
  test: string,
  variant: string,
): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("__ab", `${test}:${variant}`);
    return url.href;
  } catch {
    return baseUrl;
  }
}

/**
 * Before/after preview + traffic-split editor for one experiment. Renders
 * the site's real preview URL once per variant, each forced to that arm via
 * `?__ab=`, side by side — so "what does the treatment actually look like"
 * never requires being bucketed into it for real.
 */
/** The variant's display name in the connected split bar / weight row —
 *  capitalized role when present ("Controle"/"Tratamento"), else the raw id. */
function variantLabel(
  t: ReturnType<typeof useT>,
  v: { id: string; role?: string | null },
): string {
  if (v.role === "control") return t("experiments.preview.control");
  if (v.role === "treatment") return t("experiments.preview.treatment");
  return v.id;
}

function PreviewPanel({
  site,
  experiment,
  baseUrl,
  onBack,
}: {
  site: string;
  experiment: Experiment;
  baseUrl: string | null;
  onBack: () => void;
}) {
  const t = useT();
  const status = STATUS_STYLES[experiment.status];
  const update = useUpdateExperiment(site);
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(
      experiment.variants.map((v) => [v.id, String(v.weight)]),
    ),
  );

  const sum = Object.values(weights).reduce((a, w) => a + (Number(w) || 0), 0);
  const dirty = experiment.variants.some(
    (v) => weights[v.id] !== String(v.weight),
  );
  const total =
    experiment.variants.reduce((a, v) => a + (Number(weights[v.id]) || 0), 0) ||
    100;

  const saveSplit = () => {
    update.mutate({
      key: experiment.key,
      variants: experiment.variants.map((v) => ({
        id: v.id,
        weight: Number(weights[v.id]) || 0,
        role: v.role,
        description: v.description,
      })),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4">
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
            <ArrowLeft size={14} />
            {t("experiments.action.back")}
          </Button>
        </div>
        <div className="mt-1 flex items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-xl font-semibold">{experiment.name}</h2>
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                status.pill,
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
              {experiment.status}
            </span>
          </div>
          <Button
            onClick={saveSplit}
            disabled={!dirty || sum !== 100 || update.isPending}
          >
            {t("experiments.preview.saveChanges")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-border p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">
              {t("experiments.preview.trafficTitle")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("experiments.preview.trafficDesc")}
            </p>
          </div>
          <span
            className={cn(
              "flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
              sum === 100
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                sum === 100 ? "bg-success" : "bg-destructive",
              )}
            />
            {sum === 100
              ? t("experiments.preview.distributionValid")
              : t("experiments.dialog.weightSum", { sum })}
          </span>
        </div>

        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${experiment.variants.length}, minmax(0, 1fr))`,
          }}
        >
          {experiment.variants.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    variantBarColor(v.role),
                  )}
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">
                    {variantLabel(t, v)}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {v.id}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Input
                  value={weights[v.id]}
                  onChange={(e) =>
                    setWeights((w) => ({ ...w, [v.id]: e.target.value }))
                  }
                  inputMode="numeric"
                  className="h-8 w-16"
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
          {experiment.variants.map((v) => (
            <div
              key={v.id}
              className={cn(variantBarColor(v.role))}
              style={{
                width: `${((Number(weights[v.id]) || 0) / total) * 100}%`,
              }}
            />
          ))}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{weights[experiment.variants[0]?.id ?? ""]}%</span>
          <span>{weights[experiment.variants.at(-1)?.id ?? ""]}%</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t("experiments.preview.variantsTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("experiments.preview.variantsDesc")}
          </p>
        </div>

        {!baseUrl ? (
          <EmptyState
            title={t("experiments.preview.noUrlTitle")}
            description={t("experiments.preview.noUrlDesc")}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {experiment.variants.map((v) => (
              <div
                key={v.id}
                className="flex flex-col gap-2 overflow-hidden rounded-xl border border-border"
              >
                <div className="flex flex-col gap-1 p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2.5 w-2.5 rounded-full",
                        variantBarColor(v.role),
                      )}
                    />
                    <span className="text-sm font-semibold">
                      {variantLabel(t, v)}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {v.id}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {v.weight}%
                    </span>
                    <a
                      href={buildForcedVariantUrl(
                        baseUrl,
                        experiment.key,
                        v.id,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {t("experiments.preview.openPage")}
                      <ArrowUpRight size={12} />
                    </a>
                  </div>
                  {v.description && (
                    <p className="text-xs text-muted-foreground">
                      {v.description}
                    </p>
                  )}
                </div>
                <iframe
                  src={buildForcedVariantUrl(baseUrl, experiment.key, v.id)}
                  title={`${experiment.name} — ${v.id}`}
                  // `allow-same-origin` IS needed here, despite the usual
                  // advice against combining it with `allow-scripts` (that
                  // pair lets framed content strip its own sandbox — a real
                  // risk for arbitrary third-party content). This iframe only
                  // ever frames the developer's own local site, so that
                  // escape isn't a new capability. Without it, the framed
                  // page runs in an opaque origin and the ab-testing SDK's
                  // manifest fetch silently degrades to "no assignment" —
                  // confirmed by the same URL working when opened directly
                  // but not when framed.
                  // oxlint-disable-next-line react/iframe-missing-sandbox -- see comment above; sandbox is present and deliberately scoped
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                  className="h-[700px] w-full border-0 border-t border-border bg-background"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Full-screen review step between "Gerar"/"escrever manualmente" and
 * actually creating the experiment. Combines the editable form with a live
 * before/after preview (local dev only — see `EXPERIMENT_PREVIEW_SYNC_LOCAL`)
 * and a "reformular" box, so a wrong AI suggestion gets fixed by prompting
 * again instead of hand-editing fields that don't match what was asked for.
 */
function ReviewPanel({
  site,
  baseUrl,
  initial,
  onBack,
  onCreated,
}: {
  site: string;
  baseUrl: string | null;
  initial: SuggestedExperiment | null;
  onBack: () => void;
  /** Called once the experiment is persisted — with its key, so the caller
   *  can jump straight to that experiment's preview screen instead of just
   *  closing back to the list. */
  onCreated: (key: string) => void;
}) {
  const t = useT();
  const create = useCreateExperiment(site);
  const implementLocal = useImplementExperimentLocal(site);
  const suggest = useSuggestExperiment(site);
  const sync = useSyncExperimentPreviewLocal(site);
  const [confirming, setConfirming] = useState(false);

  const [key, setKey] = useState(initial?.key ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [hypothesis, setHypothesis] = useState(initial?.hypothesis ?? "");
  const [variants, setVariants] = useState<VariantForm[]>(
    initial?.variants.map((v) => ({
      id: v.id,
      weight: String(v.weight),
      role: v.role,
      description: v.description,
    })) ?? BLANK_VARIANTS,
  );
  const [regeneratePrompt, setRegeneratePrompt] = useState("");
  const [previewNonce, setPreviewNonce] = useState(0);
  const [synced, setSynced] = useState(false);
  // EXPERIMENT_IMPLEMENT_LOCAL isn't idempotent — it inserts a new gate on
  // every call. Once "Atualizar preview" has run it successfully for the
  // current variant text, "Criar" must not run it again (double gate/import
  // in the site's source). Any further edit to a description invalidates
  // this, since the inserted gate no longer matches what's described.
  const [implementedInSource, setImplementedInSource] = useState(false);

  const sum = variants.reduce((a, v) => a + (Number(v.weight) || 0), 0);
  const setVar = (i: number, patch: Partial<VariantForm>) => {
    setVariants((vs) =>
      vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)),
    );
    if ("description" in patch) setImplementedInSource(false);
  };

  const updatePreview = () => {
    // The manifest/admin-worker sync only lets `?__ab=` resolve a forced
    // arm — it doesn't put the actual gate in the site's code. Without also
    // (re-)running the local implementer here, the preview iframes would
    // render both arms identically until after "Criar".
    if (canImplement && !implementedInSource) {
      implementLocal.mutate(
        {
          key: key.trim(),
          variants: variants.map((v) => ({
            id: v.id.trim(),
            role: v.role || null,
            description: v.description,
          })),
        },
        { onSuccess: (result) => setImplementedInSource(result.implemented) },
      );
    }
    sync.mutate(
      {
        key: key.trim(),
        variants: variants.map((v) => ({
          id: v.id.trim(),
          weight: Number(v.weight) || 0,
        })),
      },
      {
        onSuccess: (result) => {
          setSynced(result.synced);
          setPreviewNonce((n) => n + 1);
        },
      },
    );
  };

  const regenerate = () => {
    if (!regeneratePrompt.trim()) return;
    suggest.mutate(regeneratePrompt.trim(), {
      onSuccess: (result) => {
        setKey(result.key);
        setName(result.name);
        setHypothesis(result.hypothesis);
        setVariants(
          result.variants.map((v) => ({
            id: v.id,
            weight: String(v.weight),
            role: v.role,
            description: v.description,
          })),
        );
        setRegeneratePrompt("");
      },
    });
  };

  // Only the local implementer step needs a description to work from — a
  // fully blank manual draft still creates fine, just with nothing to write.
  const canImplement = variants.some((v) => v.description?.trim());

  const confirmAndCreate = () => {
    create.mutate(
      {
        key: key.trim(),
        name: name.trim(),
        variants: variants.map((v) => ({
          id: v.id.trim(),
          weight: Number(v.weight) || 0,
          role: v.role || null,
          description: v.description || null,
        })),
      },
      {
        onSuccess: (experiment) => {
          if (canImplement && !implementedInSource) {
            implementLocal.mutate({
              key: experiment.key,
              variants: experiment.variants.map((v) => ({
                id: v.id,
                role: v.role,
                description: v.description,
              })),
            });
          }
          // Writes the local dev manifest entry so `?__ab=` forcing actually
          // takes effect on the preview screen — same write "Atualizar
          // preview" used to require as a separate click.
          sync.mutate({
            key: experiment.key,
            variants: experiment.variants.map((v) => ({
              id: v.id,
              weight: v.weight,
            })),
          });
          onCreated(experiment.key);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("experiments.action.back")}
        </Button>
        <span className="text-lg font-semibold">
          {t("experiments.prompt.reviewTitle")}
        </span>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
        {hypothesis && (
          <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs">
            <span className="font-medium text-muted-foreground">
              {t("experiments.prompt.hypothesis")}:{" "}
            </span>
            {hypothesis}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t("experiments.dialog.key")}</Label>
            <Input value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t("experiments.dialog.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">
            {t("experiments.dialog.variants")} —{" "}
            {t("experiments.dialog.weightSum", { sum })}
          </Label>
          {variants.map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editable rows
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-md border border-border p-2"
            >
              <div className="flex items-center gap-1.5">
                <Input
                  value={v.id}
                  onChange={(e) => setVar(i, { id: e.target.value })}
                  className="h-8 flex-1"
                />
                <Input
                  value={v.weight}
                  onChange={(e) => setVar(i, { weight: e.target.value })}
                  inputMode="numeric"
                  className="h-8 w-16"
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
              {/* What this arm will actually look like on the front —
                  editable here so the operator can tighten it before
                  anything is created or implemented. */}
              <Textarea
                value={v.description ?? ""}
                onChange={(e) => setVar(i, { description: e.target.value })}
                placeholder={t(
                  "experiments.dialog.variantDescriptionPlaceholder",
                )}
                rows={2}
                className="resize-none text-xs"
              />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Textarea
            value={regeneratePrompt}
            onChange={(e) => setRegeneratePrompt(e.target.value)}
            placeholder={t("experiments.prompt.regeneratePlaceholder")}
            rows={2}
            className="flex-1 resize-none"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={regenerate}
            disabled={suggest.isPending || !regeneratePrompt.trim()}
          >
            <Stars02 size={14} />
            {t("experiments.prompt.regenerate")}
          </Button>
        </div>

        {confirming ? (
          <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm font-medium">
              {t("experiments.confirm.title", { key: key.trim() })}
            </p>
            <p className="text-xs text-muted-foreground">
              {canImplement
                ? t("experiments.confirm.withImplement")
                : t("experiments.confirm.withoutImplement")}
            </p>
            <div className="flex items-center justify-end gap-2 border-t border-border pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirming(false)}
              >
                {t("experiments.dialog.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={confirmAndCreate}
                disabled={create.isPending}
              >
                {canImplement
                  ? t("experiments.confirm.proceedWithImplement")
                  : t("experiments.confirm.proceed")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={updatePreview}
              disabled={sync.isPending || !key.trim()}
            >
              {t("experiments.preview.updatePreview")}
            </Button>
            <Button
              onClick={() => setConfirming(true)}
              disabled={!key.trim() || !name.trim()}
            >
              {t("experiments.dialog.create")}
            </Button>
          </div>
        )}
      </div>

      {!baseUrl ? (
        <EmptyState
          title={t("experiments.preview.noUrlTitle")}
          description={t("experiments.preview.noUrlDesc")}
        />
      ) : !synced ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t("experiments.preview.notSyncedYet")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {variants.map((v) => (
            <div
              key={`${v.id}-${previewNonce}`}
              className="flex flex-col gap-1.5 overflow-hidden rounded-lg border border-border"
            >
              <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5">
                <span className="text-xs font-medium">
                  {v.id}
                  {v.role === "control" && (
                    <span className="ml-1.5 text-muted-foreground">
                      ({t("experiments.preview.baseline")})
                    </span>
                  )}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {v.weight}%
                </span>
                <a
                  href={buildForcedVariantUrl(baseUrl, key, v.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("experiments.preview.openPage")}
                  <ArrowUpRight size={12} />
                </a>
              </div>
              <iframe
                src={buildForcedVariantUrl(baseUrl, key, v.id)}
                title={`${name} — ${v.id}`}
                // See the matching comment in PreviewPanel's iframe —
                // `allow-same-origin` is required for the ab-testing SDK's
                // manifest fetch to resolve inside the frame at all.
                // oxlint-disable-next-line react/iframe-missing-sandbox -- sandbox is present and deliberately scoped
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                className="h-[700px] w-full border-0 bg-background"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExperimentRow({
  experiment,
  org,
  agentId,
  onStatusChange,
  onPreview,
  onEdit,
  onDelete,
  onImplement,
  implementing,
}: {
  experiment: Experiment;
  org: string;
  agentId: string;
  onStatusChange: (status: ExperimentStatus) => void;
  onPreview: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onImplement: () => void;
  implementing: boolean;
}) {
  const t = useT();
  const status = STATUS_STYLES[experiment.status];

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
      <span
        className={cn("h-2 w-2 flex-shrink-0 rounded-full", status.dot)}
        aria-hidden
      />

      <div className="flex w-56 flex-shrink-0 flex-col gap-0.5">
        <span className="text-sm font-semibold">{experiment.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {experiment.key}
        </span>
      </div>

      <SplitBar variants={experiment.variants} />

      <Select
        value={experiment.status}
        onValueChange={(v) => onStatusChange(v as ExperimentStatus)}
      >
        <SelectTrigger
          className={cn(
            "h-7 w-auto flex-shrink-0 gap-1.5 rounded-full border-0 px-3 text-xs font-medium",
            status.pill,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
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

      <Link
        to={PROJECT_ROUTE.analytics}
        params={{ org, agentId }}
        search={{ view: "experiments" }}
        className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        {t("experiments.action.viewData")}
        <ArrowUpRight size={12} />
      </Link>

      <Button
        variant="ghost"
        size="sm"
        aria-label={t("experiments.action.preview")}
        onClick={onPreview}
        className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground"
      >
        <Eye size={14} />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        aria-label={t("experiments.action.implement")}
        title={t("experiments.action.implement")}
        onClick={onImplement}
        disabled={implementing}
        className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground"
      >
        <CodeBrowser size={14} />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        aria-label={t("experiments.action.edit")}
        onClick={onEdit}
        className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground"
      >
        <Pencil01 size={14} />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        aria-label={t("experiments.action.delete")}
        onClick={onDelete}
        className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground"
      >
        <Trash01 size={14} />
      </Button>
    </div>
  );
}

export function ExperimentsTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const { org } = useProjectContext();
  const siteSlug = resolveAgentSiteSlug(entity);
  const [promptOpen, setPromptOpen] = useState(false);
  const [review, setReview] = useState<{
    open: boolean;
    initial: SuggestedExperiment | null;
  }>({ open: false, initial: null });
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    experiment: Experiment | null;
  }>({ open: false, experiment: null });
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const { data: experiments, isLoading } = useExperiments(siteSlug ?? "");
  const update = useUpdateExperiment(siteSlug ?? "");
  const del = useDeleteExperiment(siteSlug ?? "");
  const implement = useImplementExperiment(siteSlug ?? "");

  if (!siteSlug) {
    return (
      <div className="h-full min-h-0 overflow-y-auto p-8">
        <EmptyState
          title={t("experiments.title")}
          description={t("experiments.noSite")}
        />
      </div>
    );
  }

  const previewing = experiments?.find((e) => e.key === previewKey) ?? null;
  if (previewing) {
    return (
      <PreviewPanel
        site={siteSlug}
        experiment={previewing}
        baseUrl={resolvePreviewServerUrl(entity?.metadata)}
        onBack={() => setPreviewKey(null)}
      />
    );
  }

  if (review.open) {
    return (
      <ReviewPanel
        site={siteSlug}
        baseUrl={resolvePreviewServerUrl(entity?.metadata)}
        initial={review.initial}
        onBack={() => setReview({ open: false, initial: null })}
        onCreated={(key) => {
          setReview({ open: false, initial: null });
          setPreviewKey(key);
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("experiments.title")}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("experiments.subtitle")}
          </p>
        </div>
        <Button onClick={() => setPromptOpen(true)}>
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
            onClick: () => setPromptOpen(true),
          }}
        />
      ) : (
        <>
          <SummaryStrip experiments={experiments} />
          <div className="flex flex-col gap-2">
            {experiments.map((e) => (
              <ExperimentRow
                key={e.key}
                experiment={e}
                org={org.slug}
                agentId={virtualMcpId}
                onStatusChange={(status) =>
                  update.mutate({ key: e.key, status })
                }
                onPreview={() => setPreviewKey(e.key)}
                onEdit={() => setEditDialog({ open: true, experiment: e })}
                onImplement={() => {
                  if (
                    window.confirm(
                      t("experiments.implementConfirm", { key: e.key }),
                    )
                  ) {
                    implement.mutate(e.key);
                  }
                }}
                implementing={
                  implement.isPending && implement.variables === e.key
                }
                onDelete={() => {
                  if (
                    window.confirm(
                      t("experiments.deleteConfirm", { key: e.key }),
                    )
                  ) {
                    del.mutate(e.key);
                  }
                }}
              />
            ))}
          </div>
        </>
      )}

      <PromptDialog
        site={siteSlug}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onGenerated={(suggestion) =>
          setReview({ open: true, initial: suggestion })
        }
      />
      <ExperimentDialog
        key={editDialog.experiment?.key ?? "edit-none"}
        mode="edit"
        site={siteSlug}
        open={editDialog.open}
        onOpenChange={(open) => setEditDialog((s) => ({ ...s, open }))}
        initialKey={editDialog.experiment?.key}
        initialName={editDialog.experiment?.name}
        initialVariants={editDialog.experiment?.variants.map((v) => ({
          id: v.id,
          weight: String(v.weight),
          role: v.role ?? "",
          description: v.description ?? undefined,
        }))}
      />
    </div>
  );
}
