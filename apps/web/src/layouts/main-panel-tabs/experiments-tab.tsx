import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Pencil01, Stars02, Trash01 } from "@untitledui/icons";
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
import { useT } from "@/i18n/use-t.ts";
import {
  type Experiment,
  type ExperimentStatus,
  type SuggestedExperiment,
  useCreateExperiment,
  useDeleteExperiment,
  useExperiments,
  useSuggestExperiment,
  useUpdateExperiment,
} from "@/hooks/use-experiments";

const STATUSES: ExperimentStatus[] = ["draft", "running", "paused", "ended"];

/** Dot/pill colors per status — semantic, not the row's own accent (a variant
 *  split uses accent for "the non-control arm"; status is a different axis). */
const STATUS_STYLES: Record<
  ExperimentStatus,
  { dot: string; pill: string }
> = {
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
              {suggest.error instanceof Error
                ? suggest.error.message
                : "Error"}
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

function ExperimentRow({
  experiment,
  org,
  agentId,
  onStatusChange,
  onEdit,
  onDelete,
}: {
  experiment: Experiment;
  org: string;
  agentId: string;
  onStatusChange: (status: ExperimentStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
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
  const [createDialog, setCreateDialog] = useState<{
    open: boolean;
    suggestion: SuggestedExperiment | null;
  }>({ open: false, suggestion: null });
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    experiment: Experiment | null;
  }>({ open: false, experiment: null });

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

  return (
    <div className="flex flex-col gap-4 p-4">
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
                onEdit={() => setEditDialog({ open: true, experiment: e })}
                onDelete={() => {
                  if (
                    window.confirm(t("experiments.deleteConfirm", { key: e.key }))
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
          setCreateDialog({ open: true, suggestion })
        }
      />
      <ExperimentDialog
        // Remount with fresh initial values each time a new suggestion (or
        // "write manually") comes in, rather than trying to sync props into
        // already-mounted form state.
        key={createDialog.suggestion?.key ?? "manual"}
        mode="create"
        site={siteSlug}
        open={createDialog.open}
        onOpenChange={(open) => setCreateDialog((s) => ({ ...s, open }))}
        initialKey={createDialog.suggestion?.key}
        initialName={createDialog.suggestion?.name}
        initialVariants={createDialog.suggestion?.variants.map((v) => ({
          id: v.id,
          weight: String(v.weight),
          role: v.role,
        }))}
        hypothesis={createDialog.suggestion?.hypothesis}
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
        }))}
      />
    </div>
  );
}
