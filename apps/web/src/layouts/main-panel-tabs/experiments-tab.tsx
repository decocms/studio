import { type CSSProperties, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Cell, Pie, PieChart } from "recharts";
import {
  ArrowUpRight,
  ChevronDown,
  Clock,
  CodeBrowser,
  DotsHorizontal,
  Image03,
  FilterLines,
  Monitor01,
  PauseCircle,
  Pencil01,
  Phone01,
  PlayCircle,
  Plus,
  ShoppingCart01,
  Stars02,
  StopCircle,
  SwitchHorizontal01,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Slider } from "@decocms/ui/components/slider.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { SearchToggle } from "@decocms/ui/components/search-toggle.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Page } from "@/components/page";
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

const STATUSES: ExperimentStatus[] = ["running", "paused", "draft", "ended"];

const STATUS_DOT: Record<ExperimentStatus, string> = {
  running: "bg-success",
  paused: "bg-warning",
  draft: "bg-muted-foreground/60",
  ended: "bg-muted-foreground/40",
};

function useStatusLabel() {
  const t = useT();
  return (status: ExperimentStatus) => {
    switch (status) {
      case "running":
        return t("experiments.status.running");
      case "paused":
        return t("experiments.status.paused");
      case "draft":
        return t("experiments.status.draft");
      case "ended":
        return t("experiments.status.ended");
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  };
}

function StatusBadge({ status }: { status: ExperimentStatus }) {
  const label = useStatusLabel();
  return (
    <Badge variant="secondary">
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {label(status)}
    </Badge>
  );
}

type StatusAction = {
  to: ExperimentStatus;
  label: string;
  icon: typeof PlayCircle;
};

/** The transitions an operator can take from `status`, primary first. */
function useStatusActions() {
  const t = useT();
  const start = {
    to: "running",
    label: t("experiments.action.start"),
    icon: PlayCircle,
  } as const;
  const resume = { ...start, label: t("experiments.action.resume") };
  const pause = {
    to: "paused",
    label: t("experiments.action.pause"),
    icon: PauseCircle,
  } as const;
  const end = {
    to: "ended",
    label: t("experiments.action.end"),
    icon: StopCircle,
  } as const;
  return (status: ExperimentStatus): StatusAction[] => {
    switch (status) {
      case "draft":
        return [start];
      case "running":
        return [pause, end];
      case "paused":
        return [resume, end];
      case "ended":
        return [];
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  };
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** "Started 14d ago" / "Created today": the most relevant date for a row. */
function useLifecycleLabel() {
  const t = useT();
  const when = (iso: string) => {
    const days = daysSince(iso);
    return days === 0
      ? t("experiments.meta.today")
      : t("experiments.meta.daysAgo", { days });
  };
  return (e: Experiment) => {
    if (e.status === "ended" && e.endedAt) {
      return t("experiments.meta.ended", { when: when(e.endedAt) });
    }
    if (e.startedAt && e.status !== "draft") {
      return t("experiments.meta.started", { when: when(e.startedAt) });
    }
    return t("experiments.meta.created", { when: when(e.createdAt) });
  };
}

/** One variant as the page edits it, before it's saved. */
interface ArmDraft {
  id: string;
  role: "control" | "treatment" | null;
  description: string;
  weight: number;
}

function toDrafts(variants: Experiment["variants"]): ArmDraft[] {
  return variants.map((v) => ({
    id: v.id,
    role: v.role ?? null,
    description: v.description ?? "",
    weight: v.weight,
  }));
}

function toVariants(arms: ArmDraft[]): Experiment["variants"] {
  return arms.map((a) => ({
    id: a.id.trim(),
    weight: a.weight,
    role: a.role,
    description: a.description.trim() || null,
  }));
}

const BLANK_ARMS: ArmDraft[] = [
  { id: "control", role: "control", description: "", weight: 50 },
  { id: "variant-b", role: "treatment", description: "", weight: 50 },
];

/** Control is a quiet neutral; each treatment gets its own hue. */
const PRIMARY_COLOR = "var(--color-primary)";
const TREATMENT_COLORS = [
  PRIMARY_COLOR,
  "var(--color-chart-1)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
];
const CONTROL_COLOR =
  "color-mix(in oklch, var(--color-muted-foreground) 45%, transparent)";

function armColors(arms: { role?: string | null }[]): string[] {
  let treatment = 0;
  return arms.map((a) =>
    a.role === "control"
      ? CONTROL_COLOR
      : (TREATMENT_COLORS[treatment++ % TREATMENT_COLORS.length] as string),
  );
}

function armLabel(
  t: ReturnType<typeof useT>,
  arm: { id: string; role?: string | null },
): string {
  return arm.role === "control" ? t("experiments.preview.control") : arm.id;
}

/** Set arm `index` to `value` and spread the remainder over the other arms in
 *  proportion to their current weights, keeping integers that sum to 100. */
function spreadProportionally(
  weights: number[],
  index: number,
  value: number,
): number[] {
  const rest = 100 - value;
  const othersSum = weights.reduce((a, w, i) => (i === index ? a : a + w), 0);
  const raw = weights.map((w, i) =>
    i === index
      ? value
      : othersSum > 0
        ? (w / othersSum) * rest
        : rest / (weights.length - 1),
  );
  const next = raw.map((r, i) => (i === index ? value : Math.floor(r)));
  let leftover = 100 - next.reduce((a, w) => a + w, 0);
  const byFraction = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .filter(({ i }) => i !== index)
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byFraction) {
    if (leftover <= 0) break;
    next[i] = (next[i] ?? 0) + 1;
    leftover -= 1;
  }
  return next;
}

/** Set arm `index` to `value`, keeping the split at 100. Moving a treatment
 *  trades with the control first (then the other treatments), so the others
 *  keep what was set for them; moving the control spreads over the rest. */
function rebalance(
  weights: number[],
  index: number,
  value: number,
  controlIndex: number,
): number[] {
  if (weights.length < 2) return [100];
  if (controlIndex < 0 || index === controlIndex) {
    return spreadProportionally(weights, index, value);
  }
  const next = weights.map((w, i) => (i === index ? value : w));
  let excess = next.reduce((a, w) => a + w, 0) - 100;
  if (excess <= 0) {
    next[controlIndex] = (next[controlIndex] ?? 0) - excess;
    return next;
  }
  const donors = [
    controlIndex,
    ...weights
      .map((_, i) => i)
      .filter((i) => i !== index && i !== controlIndex)
      .reverse(),
  ];
  for (const j of donors) {
    const take = Math.min(next[j] ?? 0, excess);
    next[j] = (next[j] ?? 0) - take;
    excess -= take;
    if (excess === 0) break;
  }
  return next;
}

/** The arm's share, editable by typing: click the number or the pencil. */
function PercentField({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft !== null && draft.trim() !== "" && Number.isFinite(n)) {
      onCommit(Math.min(100, Math.max(0, n)));
    }
    setDraft(null);
  };

  if (draft !== null) {
    return (
      <span className="flex items-center text-xl font-medium tabular-nums">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null);
          }}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          aria-label={label}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- editing was just requested
          autoFocus
          className="field-sizing-content min-w-[2ch] bg-transparent text-right outline-none"
        />
        %
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setDraft(String(value))}
      aria-label={t("experiments.split.editPercent", { label })}
      className="group/percent flex items-center gap-1.5 rounded-md text-xl font-medium tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Pencil01
        size={14}
        className="text-muted-foreground transition-colors group-hover/percent:text-foreground"
      />
      {value}%
    </button>
  );
}

function evenSplit(n: number): number[] {
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) =>
    i === 0 ? 100 - base * (n - 1) : base,
  );
}

function SplitDonut({
  arms,
  size,
  thickness,
}: {
  arms: { id: string; role?: string | null; weight: number }[];
  size: number;
  thickness: number;
}) {
  const colors = armColors(arms);
  const outer = size / 2;
  return (
    <PieChart width={size} height={size}>
      <Pie
        data={arms.map((a) => ({ id: a.id, value: a.weight }))}
        dataKey="value"
        nameKey="id"
        innerRadius={outer - thickness}
        outerRadius={outer}
        startAngle={90}
        endAngle={450}
        paddingAngle={arms.filter((a) => a.weight > 0).length > 1 ? 2 : 0}
        cornerRadius={thickness / 4}
        stroke="none"
        isAnimationActive={false}
      >
        {arms.map((a, i) => (
          <Cell key={a.id} fill={colors[i]} />
        ))}
      </Pie>
    </PieChart>
  );
}

/**
 * Donut + one slider per variant; ids are editable only on drafts, since a live test assigns on them.
 */
function SplitCard({
  arms,
  onChange,
  structureEditable,
}: {
  arms: ArmDraft[];
  onChange: (arms: ArmDraft[]) => void;
  structureEditable: boolean;
}) {
  const t = useT();
  const colors = armColors(arms);
  const weights = arms.map((a) => a.weight);
  const controlIndex = arms.findIndex((a) => a.role === "control");
  const changedShare = arms.reduce(
    (a, arm) => (arm.role === "control" ? a : a + arm.weight),
    0,
  );
  const withWeights = (ws: number[]) =>
    onChange(arms.map((a, i) => ({ ...a, weight: ws[i] ?? 0 })));
  const patch = (i: number, p: Partial<ArmDraft>) =>
    onChange(arms.map((a, idx) => (idx === i ? { ...a, ...p } : a)));
  const even = evenSplit(arms.length);
  const isEven = even.every((w, i) => w === weights[i]);

  const addArm = () => {
    const next = [
      ...arms,
      {
        id: `variant-${String.fromCharCode(97 + arms.length)}`,
        role: "treatment" as const,
        description: "",
        weight: 0,
      },
    ];
    const ws = evenSplit(next.length);
    onChange(next.map((a, i) => ({ ...a, weight: ws[i] ?? 0 })));
  };
  const removeArm = (index: number) => {
    const next = arms.filter((_, i) => i !== index);
    const ws = evenSplit(next.length);
    onChange(next.map((a, i) => ({ ...a, weight: ws[i] ?? 0 })));
  };

  return (
    <Card className="flex-col items-center gap-10 p-8 md:flex-row">
      <div className="flex flex-shrink-0 flex-col items-center gap-4">
        <div className="relative">
          <SplitDonut arms={arms} size={240} thickness={30} />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-4xl font-medium tabular-nums">
              {changedShare}%
            </span>
            <span className="text-xs text-muted-foreground">
              {t("experiments.split.seeChange")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="tab"
            size="sm"
            aria-pressed={isEven}
            onClick={() => withWeights(even)}
          >
            {t("experiments.split.even")}
          </Button>
          {structureEditable && (
            <Button variant="ghost" size="sm" onClick={addArm}>
              <Plus size={14} />
              {t("experiments.split.addVariant")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex w-full min-w-0 flex-1 flex-col gap-7">
        {arms.map((arm, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ids are editable, position is the identity
          <div key={i} className="group flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span
                className="size-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: colors[i] }}
              />
              {structureEditable && arm.role !== "control" ? (
                <input
                  value={arm.id}
                  onChange={(e) => patch(i, { id: e.target.value })}
                  aria-label={t("experiments.split.variantName")}
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {armLabel(t, arm)}
                </span>
              )}
              {structureEditable && arm.role !== "control" && (
                <IconButton
                  label={t("experiments.split.removeVariant")}
                  onClick={() => removeArm(i)}
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <XClose size={14} />
                </IconButton>
              )}
              <PercentField
                value={arm.weight}
                label={armLabel(t, arm)}
                onCommit={(v) =>
                  withWeights(rebalance(weights, i, v, controlIndex))
                }
              />
            </div>
            {/* Scoping --primary paints each slider in its variant's color. */}
            <Slider
              value={[arm.weight]}
              max={100}
              step={1}
              onValueChange={([v]) =>
                withWeights(rebalance(weights, i, v ?? 0, controlIndex))
              }
              aria-label={armLabel(t, arm)}
              style={
                colors[i] === PRIMARY_COLOR
                  ? undefined
                  : ({ "--primary": colors[i] } as CSSProperties)
              }
            />
            <textarea
              value={arm.description}
              onChange={(e) => {
                patch(i, { description: e.target.value });
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              ref={(el) => {
                if (!el) return;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              rows={1}
              placeholder={t(
                "experiments.dialog.variantDescriptionPlaceholder",
              )}
              className="w-full resize-none overflow-hidden bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
/**
 * The "New experiment" entry point: a free-text prompt ("Valentine's Day
 * banner shows to 50% of users...") that `EXPERIMENT_SUGGEST` turns into a
 * structured proposal — the operator reviews and edits it in `ReviewPanel`
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
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      setPrompt("");
      suggest.reset();
    }
  };

  const generate = () => {
    if (!prompt.trim() || suggest.isPending) return;
    suggest.mutate(prompt.trim(), {
      onSuccess: (result) => {
        close(false);
        onGenerated(result);
      },
    });
  };

  const examples = [
    { icon: Image03, text: t("experiments.prompt.example1") },
    { icon: ShoppingCart01, text: t("experiments.prompt.example2") },
    { icon: Clock, text: t("experiments.prompt.example3") },
  ];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{t("experiments.prompt.title")}</DialogTitle>
          <DialogDescription>
            {t("experiments.prompt.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 pt-5 pb-6">
          <div className="rounded-xl bg-[var(--studio-input-background)] card-shadow transition-shadow focus-within:ring-2 focus-within:ring-ring/20">
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  generate();
                }
              }}
              placeholder={t("experiments.prompt.placeholder")}
              aria-label={t("experiments.prompt.title")}
              readOnly={suggest.isPending}
              rows={4}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to take this one input
              autoFocus
              className="block w-full resize-none bg-transparent px-4 pt-4 text-base leading-relaxed outline-none placeholder:text-muted-foreground/60"
            />
            <div className="flex items-center justify-end gap-2 px-3 pb-3">
              <span className="text-xs text-muted-foreground">
                {suggest.isPending
                  ? t("experiments.prompt.generating")
                  : t("experiments.prompt.shortcut")}
              </span>
              <Button
                size="sm"
                onClick={generate}
                disabled={suggest.isPending || !prompt.trim()}
              >
                {suggest.isPending ? (
                  <Spinner size="2xs" />
                ) : (
                  <Stars02 size={14} />
                )}
                {t("experiments.prompt.generate")}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              {t("experiments.prompt.tryOne")}
            </span>
            <div className="flex flex-wrap gap-2">
              {examples.map(({ icon: Icon, text }) => (
                <Button
                  key={text}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPrompt(text);
                    inputRef.current?.focus();
                  }}
                  disabled={suggest.isPending}
                >
                  <Icon size={14} />
                  {text}
                </Button>
              ))}
            </div>
          </div>

          {suggest.error && (
            <p className="text-xs text-destructive">
              {suggest.error instanceof Error ? suggest.error.message : "Error"}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-6 py-3">
          <span className="text-xs text-muted-foreground">
            {t("experiments.prompt.willGenerate")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              close(false);
              onGenerated(null);
            }}
          >
            <Pencil01 size={14} />
            {t("experiments.prompt.editManually")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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

function PreviewFrame({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      src={src}
      title={title}
      // oxlint-disable-next-line react/iframe-missing-sandbox -- same-origin lets the ab-testing SDK fetch its manifest; frames only the project's own site
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      className="h-full w-full border-0 bg-background"
    />
  );
}

type CompareMode = "control" | "compare" | "treatment";

/**
 * De/para: control and one treatment stacked, split by a draggable divider;
 * the one/both toggle only moves the divider, so neither page reloads.
 */
function CompareCard({
  baseUrl,
  testKey,
  arms,
  reloadNonce = 0,
}: {
  baseUrl: string;
  testKey: string;
  arms: { id: string; role?: string | null }[];
  reloadNonce?: number;
}) {
  const t = useT();
  const colors = armColors(arms);
  const control = arms.find((a) => a.role === "control") ?? arms[0];
  const treatments = arms.filter((a) => a !== control);
  const [treatmentId, setTreatmentId] = useState(treatments[0]?.id);
  const treatment =
    treatments.find((a) => a.id === treatmentId) ?? treatments[0] ?? control;
  const [mode, setMode] = useState<CompareMode>("compare");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [position, setPosition] = useState(50);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  if (!control || !treatment) return null;

  const colorOf = (arm: { id: string }) =>
    colors[arms.findIndex((a) => a.id === arm.id)] ?? CONTROL_COLOR;
  const urlOf = (arm: { id: string }) =>
    buildForcedVariantUrl(baseUrl, testKey, arm.id);
  const reveal = mode === "control" ? 100 : mode === "treatment" ? 0 : position;

  const moveTo = (clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, pct)));
  };

  // A treatment tab also sets the compared arm, so views share the two iframes.
  const showArm = (arm: { id: string }) => {
    if (arm.id === control.id) return setMode("control");
    setTreatmentId(arm.id);
    setMode("treatment");
  };
  const isShown = (arm: { id: string }) =>
    arm.id === control.id
      ? mode === "control"
      : mode === "treatment" && arm.id === treatment.id;

  return (
    <Card className="gap-4 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="tab"
            size="sm"
            aria-pressed={mode === "compare"}
            onClick={() => setMode("compare")}
          >
            <SwitchHorizontal01 size={14} />
            {t("experiments.compare.compare")}
          </Button>
          {arms.map((arm) => (
            <Button
              key={arm.id}
              variant="tab"
              size="sm"
              aria-pressed={isShown(arm)}
              onClick={() => showArm(arm)}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: colorOf(arm) }}
              />
              {armLabel(t, arm)}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="tab"
            size="icon-sm"
            aria-pressed={device === "desktop"}
            aria-label={t("experiments.compare.desktop")}
            onClick={() => setDevice("desktop")}
          >
            <Monitor01 size={14} />
          </Button>
          <Button
            variant="tab"
            size="icon-sm"
            aria-pressed={device === "mobile"}
            aria-label={t("experiments.compare.mobile")}
            onClick={() => setDevice("mobile")}
          >
            <Phone01 size={14} />
          </Button>
          {mode === "compare" ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("experiments.preview.openPage")}
                >
                  <ArrowUpRight size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {[control, treatment].map((arm) => (
                  <DropdownMenuItem key={arm.id} asChild>
                    <a
                      href={urlOf(arm)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: colorOf(arm) }}
                      />
                      {t("experiments.compare.openArm", {
                        arm: armLabel(t, arm),
                      })}
                    </a>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <IconButton
              label={t("experiments.compare.openArm", {
                arm: armLabel(t, mode === "treatment" ? treatment : control),
              })}
              asChild
            >
              <a
                href={urlOf(mode === "treatment" ? treatment : control)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ArrowUpRight size={14} />
              </a>
            </IconButton>
          )}
        </div>
      </div>

      <div
        ref={frameRef}
        className={cn(
          "relative h-[min(720px,75vh)] overflow-hidden rounded-lg bg-background card-shadow transition-[width] duration-300 ease-out",
          device === "mobile" ? "mx-auto w-[390px] max-w-full" : "w-full",
        )}
        onPointerMove={dragging ? (e) => moveTo(e.clientX) : undefined}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => setDragging(false)}
      >
        <div className="absolute inset-0">
          <PreviewFrame
            key={`${treatment.id}-${reloadNonce}`}
            src={urlOf(treatment)}
            title={armLabel(t, treatment)}
          />
        </div>
        <div
          className={cn(
            "absolute inset-0",
            !dragging && "transition-[clip-path] duration-300 ease-out",
          )}
          style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
        >
          <PreviewFrame
            key={`${control.id}-${reloadNonce}`}
            src={urlOf(control)}
            title={armLabel(t, control)}
          />
        </div>

        {/* Iframes swallow pointer events; while dragging, this catches them. */}
        {dragging && <div className="absolute inset-0 z-10 cursor-ew-resize" />}

        {mode === "compare" && (
          <>
            {[control, treatment].map((arm, i) => {
              const chip = (
                <>
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: colorOf(arm) }}
                  />
                  {armLabel(t, arm)}
                </>
              );
              const chipClass = cn(
                "absolute bottom-3 z-20 flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs font-medium card-shadow transition-opacity",
                i === 0 ? "left-3" : "right-3",
                (i === 0 ? position < 15 : position > 85) &&
                  "pointer-events-none opacity-0",
              );
              if (i === 0 || treatments.length < 2) {
                return (
                  <span
                    key={arm.id}
                    className={cn(chipClass, "pointer-events-none")}
                  >
                    {chip}
                  </span>
                );
              }
              return (
                <DropdownMenu key={arm.id} modal={false}>
                  <DropdownMenuTrigger
                    className={cn(chipClass, "hover:bg-accent")}
                    aria-label={t("experiments.compare.pickVariant")}
                  >
                    {chip}
                    <ChevronDown size={12} className="text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top">
                    {treatments.map((a) => (
                      <DropdownMenuCheckboxItem
                        key={a.id}
                        checked={a.id === treatment.id}
                        onCheckedChange={() => setTreatmentId(a.id)}
                      >
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: colorOf(a) }}
                        />
                        {armLabel(t, a)}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            })}
            <div
              className="absolute inset-y-0 z-20 flex w-6 -translate-x-1/2 cursor-ew-resize justify-center"
              style={{ left: `${position}%` }}
              onPointerDown={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
            >
              <div className="h-full w-0.5 bg-card card-shadow" />
              <button
                type="button"
                role="slider"
                aria-label={t("experiments.compare.handle")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(position)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft")
                    setPosition((p) => Math.max(0, p - 5));
                  if (e.key === "ArrowRight")
                    setPosition((p) => Math.min(100, p + 5));
                }}
                className={cn(
                  "absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full bg-card text-foreground card-shadow transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  dragging && "scale-110",
                )}
              >
                <SwitchHorizontal01 size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

type ExperimentActions = {
  onStatusChange: (status: ExperimentStatus) => void;
  onImplement: () => void;
  onDelete: () => void;
};

function sameArms(a: ArmDraft[], b: ArmDraft[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One experiment: identity and actions in the top bar, split and de/para edited in place.
 */
function ExperimentDetail({
  site,
  experiment,
  baseUrl,
  org,
  agentId,
  onBack,
  actions,
}: {
  site: string;
  experiment: Experiment;
  baseUrl: string | null;
  org: string;
  agentId: string;
  onBack: () => void;
  actions: ExperimentActions;
}) {
  const t = useT();
  const update = useUpdateExperiment(site);
  const lifecycle = useLifecycleLabel();
  const [primary, ...secondaryStatus] = useStatusActions()(experiment.status);
  const saved = toDrafts(experiment.variants);
  const [arms, setArms] = useState(saved);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(experiment.name);
  const dirty = !sameArms(arms, saved);
  const valid =
    arms.reduce((a, arm) => a + arm.weight, 0) === 100 &&
    arms.every((a) => a.id.trim()) &&
    new Set(arms.map((a) => a.id.trim())).size === arms.length;

  const save = () =>
    update.mutate({ key: experiment.key, variants: toVariants(arms) });
  const commitName = () => {
    setRenaming(false);
    const next = name.trim();
    if (next && next !== experiment.name) {
      update.mutate({ key: experiment.key, name: next });
    } else {
      setName(experiment.name);
    }
  };

  return (
    <Page>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("experiments.title"), onSelect: onBack }}
        items={[
          {
            key: "experiment",
            label: renaming ? (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") {
                    setName(experiment.name);
                    setRenaming(false);
                  }
                }}
                aria-label={t("experiments.action.rename")}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- rename was just requested from the menu
                autoFocus
                className="field-sizing-content min-w-24 max-w-md bg-transparent outline-none"
              />
            ) : (
              experiment.name
            ),
          },
        ]}
      />
      <Page.Actions
        secondary={
          <>
            <span className="hidden text-xs text-muted-foreground @lg/panel-header:inline">
              {lifecycle(experiment)}
            </span>
            <StatusBadge status={experiment.status} />
          </>
        }
      >
        {dirty ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setArms(saved)}
            >
              {t("experiments.split.reset")}
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!valid || update.isPending}
            >
              {update.isPending && <Spinner size="2xs" />}
              {t("experiments.preview.saveChanges")}
            </Button>
          </>
        ) : (
          primary && (
            <Button
              size="sm"
              onClick={() => actions.onStatusChange(primary.to)}
              disabled={update.isPending}
            >
              <primary.icon size={14} />
              {primary.label}
            </Button>
          )
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={t("experiments.action.more")}
            >
              <DotsHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil01 />
              {t("experiments.action.rename")}
            </DropdownMenuItem>
            {secondaryStatus.map((a) => (
              <DropdownMenuItem
                key={a.to}
                onSelect={() => actions.onStatusChange(a.to)}
              >
                <a.icon />
                {a.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={actions.onImplement}>
              <CodeBrowser />
              {t("experiments.action.implement")}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link
                to={PROJECT_ROUTE.analytics}
                params={{ org, agentId }}
                search={{ view: "experiments" }}
              >
                <ArrowUpRight />
                {t("experiments.action.viewData")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={actions.onDelete}>
              <Trash01 />
              {t("experiments.action.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Page.Actions>

      <Page.Content>
        <Page.Container className="flex flex-col gap-6">
          <SplitCard
            arms={arms}
            onChange={setArms}
            structureEditable={experiment.status === "draft"}
          />
          {baseUrl ? (
            <CompareCard
              baseUrl={baseUrl}
              testKey={experiment.key}
              arms={experiment.variants}
            />
          ) : (
            <EmptyState
              title={t("experiments.preview.noUrlTitle")}
              description={t("experiments.preview.noUrlDesc")}
            />
          )}
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
/**
 * Review step between the prompt and creating the experiment.
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
  /** Called with the new experiment's key so the caller can open it. */
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
  const [arms, setArms] = useState<ArmDraft[]>(
    initial ? toDrafts(initial.variants) : BLANK_ARMS,
  );
  const [regeneratePrompt, setRegeneratePrompt] = useState("");
  const [previewNonce, setPreviewNonce] = useState(0);
  const [synced, setSynced] = useState(false);
  // The local implementer isn't idempotent: run it once per set of descriptions.
  const [implementedFor, setImplementedFor] = useState<string | null>(null);

  const descriptionsKey = JSON.stringify(arms.map((a) => a.description));
  const implementedInSource = implementedFor === descriptionsKey;
  const canImplement = arms.some((a) => a.description.trim());
  const sum = arms.reduce((a, arm) => a + arm.weight, 0);
  const ready = !!key.trim() && !!name.trim() && sum === 100;

  const implementPayload = (testKey: string) => ({
    key: testKey,
    variants: toVariants(arms).map(({ id, role, description }) => ({
      id,
      role,
      description,
    })),
  });

  // Implement before reloading the iframes, or they render the pre-gate site.
  const updatePreview = async () => {
    if (canImplement && !implementedInSource) {
      const result = await implementLocal.mutateAsync(
        implementPayload(key.trim()),
      );
      if (result.implemented) setImplementedFor(descriptionsKey);
    }
    const result = await sync.mutateAsync({
      key: key.trim(),
      variants: arms.map((a) => ({ id: a.id.trim(), weight: a.weight })),
    });
    setSynced(result.synced);
    setPreviewNonce((n) => n + 1);
  };

  const regenerate = () => {
    if (!regeneratePrompt.trim()) return;
    suggest.mutate(regeneratePrompt.trim(), {
      onSuccess: (result) => {
        setKey(result.key);
        setName(result.name);
        setHypothesis(result.hypothesis);
        setArms(toDrafts(result.variants));
        setRegeneratePrompt("");
      },
    });
  };

  const confirmAndCreate = () => {
    create.mutate(
      { key: key.trim(), name: name.trim(), variants: toVariants(arms) },
      {
        onSuccess: (experiment) => {
          if (canImplement && !implementedInSource) {
            implementLocal.mutate(implementPayload(experiment.key));
          }
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

  const previewing = sync.isPending || implementLocal.isPending;

  return (
    <Page>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("experiments.title"), onSelect: onBack }}
        items={[{ key: "new", label: t("experiments.new") }]}
      />
      <Page.Actions
        secondary={
          <Button
            variant="secondary"
            size="sm"
            onClick={updatePreview}
            disabled={previewing || !key.trim()}
          >
            {previewing && <Spinner size="2xs" />}
            {t("experiments.preview.updatePreview")}
          </Button>
        }
      >
        <Button size="sm" onClick={() => setConfirming(true)} disabled={!ready}>
          {t("experiments.dialog.create")}
        </Button>
      </Page.Actions>

      <Page.Content>
        <Page.Container className="flex flex-col gap-6">
          <Card className="gap-4 p-6">
            {hypothesis && (
              <p className="text-sm">
                <span className="text-muted-foreground">
                  {t("experiments.prompt.hypothesis")}:{" "}
                </span>
                {hypothesis}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t("experiments.dialog.name")}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t("experiments.dialog.key")}</Label>
                <Input value={key} onChange={(e) => setKey(e.target.value)} />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <Textarea
                value={regeneratePrompt}
                onChange={(e) => setRegeneratePrompt(e.target.value)}
                placeholder={t("experiments.prompt.regeneratePlaceholder")}
                rows={1}
                className="flex-1 resize-none"
              />
              <Button
                variant="secondary"
                onClick={regenerate}
                disabled={suggest.isPending || !regeneratePrompt.trim()}
              >
                {suggest.isPending ? (
                  <Spinner size="2xs" />
                ) : (
                  <Stars02 size={14} />
                )}
                {t("experiments.prompt.regenerate")}
              </Button>
            </div>
          </Card>

          <SplitCard arms={arms} onChange={setArms} structureEditable />

          {!baseUrl ? (
            <EmptyState
              title={t("experiments.preview.noUrlTitle")}
              description={t("experiments.preview.noUrlDesc")}
            />
          ) : synced ? (
            <CompareCard
              baseUrl={baseUrl}
              testKey={key.trim()}
              arms={arms}
              reloadNonce={previewNonce}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              {t("experiments.preview.notSyncedYet")}
            </p>
          )}
        </Page.Container>
      </Page.Content>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("experiments.confirm.title", { key: key.trim() })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {canImplement
                ? t("experiments.confirm.withImplement")
                : t("experiments.confirm.withoutImplement")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("experiments.dialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAndCreate}
              disabled={create.isPending}
            >
              {canImplement
                ? t("experiments.confirm.proceedWithImplement")
                : t("experiments.confirm.proceed")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
function ExperimentRow({
  experiment,
  onOpen,
  actions,
}: {
  experiment: Experiment;
  onOpen: () => void;
  actions: ExperimentActions;
}) {
  const t = useT();
  const lifecycle = useLifecycleLabel();
  const statusActions = useStatusActions()(experiment.status);
  const treatments = experiment.variants.filter((v) => v.role !== "control");
  return (
    <div className="group relative flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Stretched over the row so the whole row opens the experiment. */}
        <button
          type="button"
          onClick={onOpen}
          className="truncate text-left text-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        >
          {experiment.name}
        </button>
        <span className="truncate text-xs text-muted-foreground">
          {treatments.map((v) => v.description || v.id).join(" · ")}
        </span>
      </div>

      <div className="flex w-36 flex-shrink-0 items-center gap-2.5">
        <SplitDonut arms={experiment.variants} size={22} thickness={5} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {experiment.variants.map((v) => v.weight).join(" / ")}
        </span>
      </div>
      <span className="hidden w-32 flex-shrink-0 text-xs text-muted-foreground md:block">
        {lifecycle(experiment)}
      </span>
      <div className="flex w-24 flex-shrink-0">
        <StatusBadge status={experiment.status} />
      </div>
      <div className="relative z-10 flex-shrink-0">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("experiments.action.more")}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <DotsHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {statusActions.map((a) => (
              <DropdownMenuItem
                key={a.to}
                onSelect={() => actions.onStatusChange(a.to)}
              >
                <a.icon />
                {a.label}
              </DropdownMenuItem>
            ))}
            {statusActions.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onSelect={actions.onDelete}>
              <Trash01 />
              {t("experiments.action.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

type PendingConfirm = { kind: "delete" | "implement"; key: string } | null;

export function ExperimentsTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const statusLabel = useStatusLabel();
  const entity = useVirtualMCP(virtualMcpId);
  const { org } = useProjectContext();
  const siteSlug = resolveAgentSiteSlug(entity);
  const baseUrl = resolvePreviewServerUrl(entity?.metadata);
  const [promptOpen, setPromptOpen] = useState(false);
  const [review, setReview] = useState<{
    open: boolean;
    initial: SuggestedExperiment | null;
  }>({ open: false, initial: null });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ExperimentStatus[]>([]);
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<PendingConfirm>(null);

  const { data: experiments, isLoading } = useExperiments(siteSlug ?? "");
  const update = useUpdateExperiment(siteSlug ?? "");
  const del = useDeleteExperiment(siteSlug ?? "");
  const implement = useImplementExperiment(siteSlug ?? "");

  if (!siteSlug) {
    return (
      <Page>
        <Page.Content>
          <Page.Container>
            <EmptyState
              title={t("experiments.title")}
              description={t("experiments.noSite")}
            />
          </Page.Container>
        </Page.Content>
      </Page>
    );
  }

  const actionsFor = (e: Experiment): ExperimentActions => ({
    onStatusChange: (status) => update.mutate({ key: e.key, status }),
    onImplement: () => setConfirm({ kind: "implement", key: e.key }),
    onDelete: () => setConfirm({ kind: "delete", key: e.key }),
  });

  const confirmDialog = (
    <AlertDialog
      open={!!confirm}
      onOpenChange={(open) => !open && setConfirm(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirm?.kind === "delete"
              ? t("experiments.deleteTitle")
              : t("experiments.implementTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirm?.kind === "delete"
              ? t("experiments.deleteConfirm", { key: confirm.key })
              : t("experiments.implementConfirm", { key: confirm?.key ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("experiments.dialog.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (!confirm) return;
              if (confirm.kind === "delete") {
                del.mutate(confirm.key);
                if (openKey === confirm.key) setOpenKey(null);
              } else {
                implement.mutate(confirm.key);
              }
            }}
          >
            {confirm?.kind === "delete"
              ? t("experiments.action.delete")
              : t("experiments.implementProceed")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const opened = experiments?.find((e) => e.key === openKey) ?? null;
  if (opened) {
    return (
      <>
        <ExperimentDetail
          key={opened.key}
          site={siteSlug}
          experiment={opened}
          baseUrl={baseUrl}
          org={org.slug}
          agentId={virtualMcpId}
          onBack={() => setOpenKey(null)}
          actions={actionsFor(opened)}
        />
        {confirmDialog}
      </>
    );
  }

  if (review.open) {
    return (
      <ReviewPanel
        site={siteSlug}
        baseUrl={baseUrl}
        initial={review.initial}
        onBack={() => setReview({ open: false, initial: null })}
        onCreated={(key) => {
          setReview({ open: false, initial: null });
          setOpenKey(key);
        }}
      />
    );
  }

  const countOf = (status: ExperimentStatus) =>
    experiments?.filter((e) => e.status === status).length ?? 0;
  const query = search.trim().toLowerCase();
  const visible = (experiments ?? [])
    .filter((e) => statusFilter.length === 0 || statusFilter.includes(e.status))
    .filter((e) => !query || e.name.toLowerCase().includes(query))
    .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));

  return (
    <Page>
      <Page.Actions
        secondary={
          !!experiments?.length && (
            <div className="flex items-center gap-2">
              <SearchToggle
                value={search}
                onChange={setSearch}
                label={t("experiments.filter.searchLabel")}
                placeholder={t("experiments.filter.searchPlaceholder")}
                clearLabel={t("experiments.filter.searchClear")}
              />
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    label={t("experiments.filter.label")}
                    tooltipSide="bottom"
                    variant="secondary"
                    aria-pressed={statusFilter.length > 0}
                  >
                    <FilterLines />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>
                    {t("experiments.filter.status")}
                  </DropdownMenuLabel>
                  {STATUSES.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s}
                      checked={statusFilter.includes(s)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) =>
                        setStatusFilter((prev) =>
                          checked ? [...prev, s] : prev.filter((x) => x !== s),
                        )
                      }
                    >
                      <span
                        className={cn("size-1.5 rounded-full", STATUS_DOT[s])}
                      />
                      {statusLabel(s)}
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {countOf(s)}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        }
      >
        <Button size="sm" onClick={() => setPromptOpen(true)}>
          <Plus size={16} />
          {t("experiments.new")}
        </Button>
      </Page.Actions>

      <Page.Content>
        <Page.Container>
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
          ) : visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t("experiments.filter.empty")}
            </p>
          ) : (
            <Card className="gap-0 divide-y divide-border overflow-hidden">
              {visible.map((e) => (
                <ExperimentRow
                  key={e.key}
                  experiment={e}
                  onOpen={() => setOpenKey(e.key)}
                  actions={actionsFor(e)}
                />
              ))}
            </Card>
          )}
        </Page.Container>
      </Page.Content>

      <PromptDialog
        site={siteSlug}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onGenerated={(suggestion) =>
          setReview({ open: true, initial: suggestion })
        }
      />
      {confirmDialog}
    </Page>
  );
}
