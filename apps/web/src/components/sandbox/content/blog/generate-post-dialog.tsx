import { useState } from "react";
import { Stars02 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { LAST_CONFIG_KEY } from "@/components/file-picker/file-picker-dialog";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { resolveTargetConfigId } from "@/components/sections-editor/fields/resolve-target-config-id";
import {
  type BrandRequirement,
  type CampaignEntry,
  FORMATS_BLOCK_KEY,
  filledBrandRules,
  missingBrandForGeneration,
  normalizeBrandRules,
  readBlogContext,
  scanCampaigns,
} from "./blog-data";
import { PickList } from "./blocks/primitives";
import type { PostBriefing } from "./use-generate-post";

const STEPS = [
  { id: "campaign", label: "sandbox.generatePost.stepCampaign" },
  { id: "format", label: "sandbox.generatePost.stepFormat" },
  { id: "extra", label: "sandbox.generatePost.stepExtra" },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey }>;

type StepId = (typeof STEPS)[number]["id"];

/** How many drafts one run may write. The tool refuses more. */
const COUNTS = [1, 2, 3] as const;

/** Which brand field each blocking requirement points at, for the message. */
const REQUIREMENT_LABEL = {
  companyName: "sandbox.blogBrand.companyNameLabel",
  language: "sandbox.blogBrand.languageLabel",
  description: "sandbox.blogBrand.descriptionLabel",
  tone: "sandbox.blogBrand.toneLabel",
  targetAudience: "sandbox.blogBrand.audienceLabel",
  dos: "sandbox.blogBrand.tabDos",
  avoid: "sandbox.blogBrand.tabGuardrails",
} as const satisfies Record<BrandRequirement, TranslationKey>;

/**
 * The generation happy path: which campaign, in what shape, with what else.
 *
 * A campaign rather than a loose idea, because the campaign is what already
 * carries the moment, the products it may name, the links to them and the tone
 * the brand takes while it runs. Writing from anything less means the post has
 * to invent all four.
 */
export function GeneratePostDialog({
  open,
  onOpenChange,
  decofile,
  hasAi,
  onGenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decofile: Record<string, unknown>;
  hasAi: boolean;
  onGenerate: (briefing: PostBriefing) => void;
}) {
  const t = useT();
  const configsQuery = useFileConfigsQuery();

  const [step, setStep] = useState<StepId>("campaign");
  const [campaignKey, setCampaignKey] = useState("");
  const [formatName, setFormatName] = useState("");
  const [formatValue, setFormatValue] = useState("");
  const [extra, setExtra] = useState("");
  const [count, setCount] = useState<number>(1);

  const { merged } = readBlogContext(decofile);
  const missingBrand = missingBrandForGeneration(merged);

  const campaigns = scanCampaigns(decofile).filter(
    (campaign) => campaign.status !== "finished",
  );
  const picked = campaigns.find((campaign) => campaign.key === campaignKey);
  const formatsBlock = decofile[FORMATS_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const formats = filledBrandRules(normalizeBrandRules(formatsBlock?.formats));

  const reset = () => {
    setStep("campaign");
    setCampaignKey("");
    setFormatName("");
    setFormatValue("");
    setExtra("");
    setCount(1);
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) reset();
  };

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const canAdvance =
    step === "campaign"
      ? !!picked
      : step === "format"
        ? formatName.trim().length > 0 && formatValue.trim().length > 0
        : true;
  const isLast = step === "extra";

  const submit = () => {
    if (!picked) return;
    onGenerate({
      campaign: picked,
      format: { name: formatName.trim(), value: formatValue.trim() },
      extraInstructions: extra.trim() || undefined,
      count,
      fileConfigId:
        resolveTargetConfigId(
          configsQuery.data?.configs ?? [],
          null,
          typeof window !== "undefined"
            ? window.localStorage.getItem(LAST_CONFIG_KEY)
            : null,
        ) ?? undefined,
    });
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("sandbox.generatePost.title")}</DialogTitle>
          <DialogDescription>
            {t("sandbox.generatePost.subtitle")}
          </DialogDescription>
        </DialogHeader>

        {missingBrand.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("sandbox.generatePost.blockedBrand", {
              fields: missingBrand
                .map((f) => t(REQUIREMENT_LABEL[f]))
                .join(", "),
            })}
          </p>
        ) : (
          <>
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
              {step === "campaign" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.generatePost.campaignHint")}
                  </p>
                  {campaigns.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                      {t("sandbox.generatePost.noCampaigns")}
                    </p>
                  ) : (
                    <CampaignList
                      campaigns={campaigns}
                      chosen={campaignKey}
                      onChoose={setCampaignKey}
                    />
                  )}
                </>
              )}

              {step === "format" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.generatePost.formatHint")}
                  </p>
                  <PickList
                    options={formats.map((f) => f.name)}
                    value={formatName}
                    onChange={(name) => {
                      setFormatName(name);
                      setFormatValue(
                        formats.find((f) => f.name === name)?.value ?? "",
                      );
                    }}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="generate-format-name">
                      {t("sandbox.generatePost.formatNameLabel")}
                    </Label>
                    <Input
                      id="generate-format-name"
                      value={formatName}
                      onChange={(e) => setFormatName(e.target.value)}
                      placeholder={t(
                        "sandbox.generatePost.formatNamePlaceholder",
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="generate-format-value">
                      {t("sandbox.generatePost.formatValueLabel")}
                    </Label>
                    <Textarea
                      id="generate-format-value"
                      value={formatValue}
                      onChange={(e) => setFormatValue(e.target.value)}
                      placeholder={t(
                        "sandbox.generatePost.formatValuePlaceholder",
                      )}
                      rows={4}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.generatePost.formatBlocksHint")}
                  </p>
                </>
              )}

              {step === "extra" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="generate-extra">
                      {t("sandbox.generatePost.extraLabel")}
                    </Label>
                    <Textarea
                      id="generate-extra"
                      value={extra}
                      onChange={(e) => setExtra(e.target.value)}
                      placeholder={t("sandbox.generatePost.extraPlaceholder")}
                      rows={4}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("sandbox.generatePost.countLabel")}</Label>
                    <PickList
                      options={COUNTS.map(String)}
                      value={String(count)}
                      onChange={(value) => setCount(Number(value) || 1)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("sandbox.generatePost.countHint")}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.generatePost.coverHint")}
                  </p>
                </>
              )}
            </div>

            <DialogFooter className="shrink-0 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={stepIndex === 0}
                onClick={() => setStep(STEPS[stepIndex - 1]!.id)}
              >
                {t("sandbox.generatePost.back")}
              </Button>
              {isLast ? (
                <Button type="button" disabled={!hasAi} onClick={submit}>
                  <Stars02 size={14} />
                  {t("sandbox.generatePost.generate", {
                    count: String(count),
                  })}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={!canAdvance}
                  onClick={() => setStep(STEPS[stepIndex + 1]!.id)}
                >
                  {t("sandbox.generatePost.next")}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The campaigns on offer, as cards — a name alone does not say what it is for. */
function CampaignList({
  campaigns,
  chosen,
  onChoose,
}: {
  campaigns: CampaignEntry[];
  chosen: string;
  onChoose: (key: string) => void;
}) {
  const t = useT();
  return (
    <ul className="space-y-1.5">
      {campaigns.map((campaign) => (
        <li key={campaign.key}>
          <button
            type="button"
            onClick={() => onChoose(campaign.key)}
            className={cn(
              "w-full cursor-pointer rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/40",
              chosen === campaign.key && "border-primary",
            )}
          >
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                {campaign.name || t("sandbox.campaigns.untitled")}
              </p>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {campaign.intent.products.length > 0
                  ? t("sandbox.generatePost.campaignProducts", {
                      count: String(campaign.intent.products.length),
                    })
                  : t("sandbox.generatePost.campaignNoProducts")}
              </Badge>
            </div>
            {campaign.trigger.note && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {campaign.trigger.note}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
