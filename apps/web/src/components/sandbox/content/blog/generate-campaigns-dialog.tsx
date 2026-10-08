/**
 * The campaign generation wizard.
 *
 * Filling a campaign in by hand means knowing what sells, what has stalled and
 * what people search for and do not find — all of it in the brand's systems
 * rather than in anyone's head. So this starts from a seed, reaches those
 * systems through the site's MCP connections, and comes back with candidates.
 *
 * It proposes up to three and lets the person choose, because the seed usually
 * admits more than one reading. When it does not, the model is told to return
 * one rather than pad the list.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AlertTriangle, Check, Stars02 } from "@untitledui/icons";
import { toast } from "sonner";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { TermsInput } from "./blocks/rule-list";
import {
  type CampaignSeedEntry,
  contextForTools,
  emptyCampaignSeed,
  newCampaignSeedKey,
  readBlogContext,
  scanCampaigns,
  scanCampaignSeeds,
} from "./blog-data";

const STEPS = [
  { id: "seed", label: "sandbox.campaignGen.stepSeed" },
  { id: "running", label: "sandbox.campaignGen.stepRunning" },
  { id: "pick", label: "sandbox.campaignGen.stepPick" },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey }>;

type StepId = (typeof STEPS)[number]["id"];

export type SuggestedCampaign =
  StudioToolOutput<"BLOG_CAMPAIGN_SUGGEST">["campaigns"][number];

type Result = StudioToolOutput<"BLOG_CAMPAIGN_SUGGEST">;

const VERDICT_LABEL: Record<
  SuggestedCampaign["review"]["verdict"],
  TranslationKey
> = {
  strong: "sandbox.campaignGen.verdictStrong",
  workable: "sandbox.campaignGen.verdictWorkable",
  weak: "sandbox.campaignGen.verdictWeak",
};

const VERDICT_VARIANT: Record<
  SuggestedCampaign["review"]["verdict"],
  "default" | "secondary" | "outline"
> = {
  strong: "default",
  workable: "secondary",
  weak: "outline",
};

/** The phases of a run, so a long wait reads as progress rather than a hang. */
const PHASES = [
  "sandbox.campaignGen.phaseReading",
  "sandbox.campaignGen.phaseWriting",
  "sandbox.campaignGen.phaseReviewing",
] as const satisfies ReadonlyArray<TranslationKey>;

/** Reading the store dominates the wait, so the first phase holds longest. */
const PHASE_MS = [25_000, 25_000];

export function GenerateCampaignsDialog({
  open,
  onOpenChange,
  decofile,
  virtualMcpId,
  hasAi,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decofile: Record<string, unknown>;
  virtualMcpId: string;
  hasAi: boolean;
  /** Persists the seed and the chosen candidates; the panel owns the writes. */
  onCreate: (
    seed: { key: string; entry: Omit<CampaignSeedEntry, "key"> },
    chosen: SuggestedCampaign[],
  ) => Promise<void>;
}) {
  const t = useT();
  const { call } = useStudioTools();

  const [step, setStep] = useState<StepId>("seed");
  const [seedKey, setSeedKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(3);
  const [phase, setPhase] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [creating, setCreating] = useState(false);

  const savedSeeds = scanCampaignSeeds(decofile);
  const existingNames = scanCampaigns(decofile)
    .map((c) => c.name)
    .filter(Boolean);
  const brand = contextForTools(readBlogContext(decofile).merged);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const canRun = prompt.trim().length > 0 && hasAi;

  function reset() {
    setStep("seed");
    setSeedKey(null);
    setName("");
    setKeywords([]);
    setPrompt("");
    setCount(3);
    setPhase(0);
    setResult(null);
    setChosen(new Set());
    setCreating(false);
  }

  function close(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /** Load a saved seed into the form, so running it again is one click. */
  function loadSeed(seed: CampaignSeedEntry) {
    setSeedKey(seed.key);
    setName(seed.name);
    setKeywords(seed.keywords);
    setPrompt(seed.prompt);
  }

  async function run() {
    setStep("running");
    setPhase(0);
    const timers = PHASE_MS.map((_, i) =>
      setTimeout(
        () => setPhase(i + 1),
        PHASE_MS.slice(0, i + 1).reduce((a, b) => a + b, 0),
      ),
    );
    try {
      const output = await call("BLOG_CAMPAIGN_SUGGEST", {
        seed: { keywords, prompt },
        brand,
        existingNames,
        count,
        virtualMcpId,
      });
      setResult(output);
      setChosen(new Set(output.campaigns.map((_, i) => i)));
      setStep("pick");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.campaignGen.failed"),
      );
      setStep("seed");
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  }

  async function create() {
    if (!result) return;
    const picked = result.campaigns.filter((_, i) => chosen.has(i));
    if (picked.length === 0) return;
    setCreating(true);
    try {
      const now = new Date();
      await onCreate(
        {
          key: seedKey ?? newCampaignSeedKey(),
          entry: {
            ...emptyCampaignSeed(now),
            name: name || prompt.slice(0, 60),
            keywords,
            prompt,
          },
        },
        picked,
      );
      close(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.campaignGen.failed"),
      );
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("sandbox.campaignGen.title")}</DialogTitle>
          <DialogDescription>
            {t("sandbox.campaignGen.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <ol className="flex shrink-0 items-center gap-1.5 text-xs">
          {STEPS.map((entry, index) => (
            <li
              key={entry.id}
              className={cn(
                "rounded-md px-2 py-1",
                index === stepIndex
                  ? "bg-primary text-primary-foreground"
                  : index < stepIndex
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {t(entry.label)}
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-1">
          {step === "seed" && (
            <>
              {savedSeeds.length > 0 && (
                <div className="space-y-1.5">
                  <Label>{t("sandbox.campaignGen.savedSeeds")}</Label>
                  <ul className="divide-y overflow-hidden rounded-lg border">
                    {savedSeeds.map((seed) => (
                      <li key={seed.key}>
                        <button
                          type="button"
                          onClick={() => loadSeed(seed)}
                          className={cn(
                            "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50",
                            seedKey === seed.key && "bg-muted/60",
                          )}
                        >
                          <span className="truncate font-medium">
                            {seed.name || t("sandbox.campaignGen.untitledSeed")}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {seed.prompt}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="seed-name">
                  {t("sandbox.campaignGen.seedNameLabel")}
                </Label>
                <Input
                  id="seed-name"
                  value={name}
                  placeholder={t("sandbox.campaignGen.seedNamePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="seed-prompt">
                  {t("sandbox.campaignGen.promptLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.campaignGen.promptHint")}
                </p>
                <Textarea
                  id="seed-prompt"
                  value={prompt}
                  rows={4}
                  placeholder={t("sandbox.campaignGen.promptPlaceholder")}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label>{t("sandbox.campaignGen.keywordsLabel")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.campaignGen.keywordsHint")}
                </p>
                <TermsInput
                  terms={keywords}
                  onChange={setKeywords}
                  placeholder={t("sandbox.campaignGen.keywordsPlaceholder")}
                  removeLabel={t("sandbox.campaignGen.removeKeyword")}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="seed-count">
                  {t("sandbox.campaignGen.countLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.campaignGen.countHint")}
                </p>
                <Input
                  id="seed-count"
                  type="number"
                  min={1}
                  max={3}
                  value={count}
                  onChange={(e) =>
                    setCount(
                      Math.min(3, Math.max(1, Number(e.target.value) || 1)),
                    )
                  }
                  className="w-24"
                />
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.postBoard.usesCredits")}
                </p>
              </div>
            </>
          )}

          {step === "running" && (
            <ul className="space-y-3 py-6">
              {PHASES.map((label, index) => (
                <li
                  key={label}
                  className={cn(
                    "flex items-center gap-2 text-sm",
                    index > phase && "text-muted-foreground",
                  )}
                >
                  {index < phase ? (
                    <Check size={14} className="text-success" />
                  ) : index === phase ? (
                    <Spinner size="xs" />
                  ) : (
                    <span className="size-3.5" />
                  )}
                  {t(label)}
                </li>
              ))}
            </ul>
          )}

          {step === "pick" && result && (
            <>
              {result.gaps.length > 0 && (
                <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <AlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0 text-warning"
                  />
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {result.gaps.map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.campaigns.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("sandbox.campaignGen.noCandidates")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {result.campaigns.map((campaign, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        onClick={() =>
                          setChosen((prev) => {
                            const next = new Set(prev);
                            if (next.has(index)) next.delete(index);
                            else next.add(index);
                            return next;
                          })
                        }
                        className={cn(
                          "w-full cursor-pointer space-y-2 rounded-lg border p-3 text-left transition-colors",
                          chosen.has(index)
                            ? "border-primary bg-primary/5"
                            : "bg-card hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={cn(
                              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                              chosen.has(index) &&
                                "border-primary bg-primary text-primary-foreground",
                            )}
                          >
                            {chosen.has(index) && <Check size={11} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {campaign.name}
                          </span>
                          <Badge
                            variant={VERDICT_VARIANT[campaign.review.verdict]}
                          >
                            {t(VERDICT_LABEL[campaign.review.verdict])}
                          </Badge>
                        </div>

                        <p className="text-xs text-muted-foreground">
                          {t("sandbox.campaignGen.cardSummary", {
                            targets: String(campaign.intent.targets.length),
                            products: String(campaign.intent.products.length),
                          })}
                          {campaign.period.start || campaign.period.end
                            ? ` · ${campaign.period.start ?? "—"} / ${campaign.period.end ?? "—"}`
                            : ""}
                        </p>

                        {campaign.review.rationale && (
                          <p className="text-xs text-muted-foreground">
                            {campaign.review.rationale}
                          </p>
                        )}

                        {campaign.review.risks.length > 0 && (
                          <ul className="space-y-0.5 text-xs text-muted-foreground">
                            {campaign.review.risks.map((risk) => (
                              <li key={risk}>— {risk}</li>
                            ))}
                          </ul>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={step !== "pick"}
            onClick={() => setStep("seed")}
          >
            {t("sandbox.campaignGen.back")}
          </Button>
          {step === "pick" ? (
            <Button
              type="button"
              disabled={chosen.size === 0 || creating}
              onClick={create}
            >
              {t("sandbox.campaignGen.create", { count: String(chosen.size) })}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!canRun || step === "running"}
              onClick={run}
            >
              <Stars02 size={14} />
              {t("sandbox.campaignGen.generate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
