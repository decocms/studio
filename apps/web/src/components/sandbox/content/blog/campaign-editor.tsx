/**
 * One campaign's form, autosaved like every other Context editor.
 *
 * The fields are grouped the way the object is, because the grouping carries
 * meaning a flat form would lose: `trigger` is why the campaign exists,
 * `intent` is what it is trying to do and to what, `guardrails` is what the
 * writing may not do. Two of those names are promises about precedence —
 * `avoidComplements` adds to the brand's guardrails, `toneOverrides` replaces
 * the brand's tone — and the hints under them say so, because a form that
 * silently overrides the brand context is a trap.
 */

import { useState } from "react";
import { Calendar } from "@decocms/ui/components/calendar.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@decocms/ui/components/dialog.tsx";
import {
  CalendarDate,
  HelpCircle,
  SearchSm,
  Trash01,
  X,
} from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useAutosave } from "./use-autosave";
import { AddButton, PickList, RemoveButton } from "./blocks/primitives";
import { CollapsibleList, CollapsibleRow } from "./blocks/collapsible-row";
import { RuleList, TermsInput } from "./blocks/rule-list";
import { CategoryTreeList } from "./blocks/category-tree-list";
import { reHome } from "./blocks/store-url";
import { ProductPickerDialog } from "./blocks/product-picker-dialog";
import type { ProductPickerOption } from "./blocks/product-picker-source";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { ImageField } from "@/components/sections-editor/fields/image-field";
import type { SandboxConfig } from "@/components/sections-editor/fields/field-props";
import {
  buildCampaignBlock,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  type CampaignEntry,
  type CampaignObjective,
  type CampaignProduct,
  type CampaignStatus,
  type CampaignTarget,
  type CampaignTargetKind,
  type CampaignTrigger,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
  normalizeBrandRules,
  readCampaignProducts,
  readCampaignTargets,
  scanCampaigns,
} from "./blog-data";
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_TRIGGER_LABEL,
} from "./campaigns-panel";
import type { TranslationKey } from "@/i18n/use-t.ts";

const OBJECTIVE_LABEL: Record<CampaignObjective, TranslationKey> = {
  awareness: "sandbox.campaigns.objectiveAwareness",
  education: "sandbox.campaigns.objectiveEducation",
  conversion: "sandbox.campaigns.objectiveConversion",
  retention: "sandbox.campaigns.objectiveRetention",
  repositioning: "sandbox.campaigns.objectiveRepositioning",
};

const TARGET_KIND_LABEL: Record<CampaignTargetKind, TranslationKey> = {
  category: "sandbox.campaigns.targetCategory",
  collection: "sandbox.campaigns.targetCollection",
};

/**
 * When to reach for each option. These are the two fields generation leans on
 * hardest, and the bare labels are jargon — "awareness" tells someone who
 * already knows the vocabulary nothing they did not know, and everyone else
 * nothing at all. Kept beside the chips rather than under them: a permanent
 * twelve-line legend would bury the form.
 */
const TRIGGER_HELP: Record<CampaignTrigger, TranslationKey> = {
  launch: "sandbox.campaigns.triggerLaunchHelp",
  seasonal: "sandbox.campaigns.triggerSeasonalHelp",
  trend: "sandbox.campaigns.triggerTrendHelp",
  seo_gap: "sandbox.campaigns.triggerSeoGapHelp",
  inventory: "sandbox.campaigns.triggerInventoryHelp",
  partnership: "sandbox.campaigns.triggerPartnershipHelp",
  reputation: "sandbox.campaigns.triggerReputationHelp",
};

const OBJECTIVE_HELP: Record<CampaignObjective, TranslationKey> = {
  awareness: "sandbox.campaigns.objectiveAwarenessHelp",
  education: "sandbox.campaigns.objectiveEducationHelp",
  conversion: "sandbox.campaigns.objectiveConversionHelp",
  retention: "sandbox.campaigns.objectiveRetentionHelp",
  repositioning: "sandbox.campaigns.objectiveRepositioningHelp",
};

/** The four questions that actually tell the objectives apart. */
const OBJECTIVE_FACETS: Record<
  CampaignObjective,
  Record<"content" | "product" | "cta" | "metric", TranslationKey>
> = {
  awareness: {
    content: "sandbox.campaigns.objectiveAwarenessContent",
    product: "sandbox.campaigns.objectiveAwarenessProduct",
    cta: "sandbox.campaigns.objectiveAwarenessCta",
    metric: "sandbox.campaigns.objectiveAwarenessMetric",
  },
  education: {
    content: "sandbox.campaigns.objectiveEducationContent",
    product: "sandbox.campaigns.objectiveEducationProduct",
    cta: "sandbox.campaigns.objectiveEducationCta",
    metric: "sandbox.campaigns.objectiveEducationMetric",
  },
  conversion: {
    content: "sandbox.campaigns.objectiveConversionContent",
    product: "sandbox.campaigns.objectiveConversionProduct",
    cta: "sandbox.campaigns.objectiveConversionCta",
    metric: "sandbox.campaigns.objectiveConversionMetric",
  },
  retention: {
    content: "sandbox.campaigns.objectiveRetentionContent",
    product: "sandbox.campaigns.objectiveRetentionProduct",
    cta: "sandbox.campaigns.objectiveRetentionCta",
    metric: "sandbox.campaigns.objectiveRetentionMetric",
  },
  repositioning: {
    content: "sandbox.campaigns.objectiveRepositioningContent",
    product: "sandbox.campaigns.objectiveRepositioningProduct",
    cta: "sandbox.campaigns.objectiveRepositioningCta",
    metric: "sandbox.campaigns.objectiveRepositioningMetric",
  },
};

/** Only the two objectives that reliably pair with a trigger say so. */
const OBJECTIVE_NOTE: Partial<Record<CampaignObjective, TranslationKey>> = {
  education: "sandbox.campaigns.objectiveEducationNote",
  conversion: "sandbox.campaigns.objectiveConversionNote",
};

/** Stable empty seed — `useAutosave` re-seeds on reference change, so a fresh
 *  `{}` each render would re-seed on every render instead of only on a refetch. */
const EMPTY_BLOCK: Record<string, unknown> = {};

/** `YYYY-MM-DD` from a picked day, in local time — not `toISOString`, which
 *  shifts the date backwards for anyone west of UTC. */
function isoDay(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function parseDay(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** The one campaign this block holds, read back through the same scanner the
 *  board uses so the editor and the card can never disagree. */
function readCampaign(
  blockKey: string,
  block: Record<string, unknown> | undefined,
): Omit<CampaignEntry, "key"> {
  const [found] = scanCampaigns({ [blockKey]: block ?? {} });
  const { key: _key, ...rest } = found ?? {
    key: blockKey,
    name: "",
    seedKey: "",
    status: "draft" as CampaignStatus,
    period: { start: null, end: null },
    trigger: { type: "seasonal" as CampaignTrigger, note: "" },
    intent: {
      objective: "awareness" as CampaignObjective,
      targets: [],
      products: [],
      keywords: [],
    },
    guardrails: { avoidComplements: [], toneOverrides: "" },
    createdAt: "",
    updatedAt: "",
  };
  return rest;
}

export function CampaignEditor({
  blockKey,
  block,
  onSave,
  onRemove,
  onClose,
  isSaving,
  sandboxRef,
  storeUrl,
}: {
  blockKey: string;
  block: Record<string, unknown> | undefined;
  onSave: (data: Record<string, unknown>) => void;
  onRemove: () => void;
  /** Only the board shows a close affordance; the list pane is always open. */
  onClose?: () => void;
  /** Blocks `useAutosave` from re-seeding mid-write: the decofile refetch that
   *  follows a save can still carry the pre-rebuild block, and re-seeding from
   *  it reverts the edit that caused the save. */
  isSaving?: boolean;
  /** Absent outside a sandbox session — the store pickers hide, typing stays. */
  sandboxRef?: PreviewProxyRef;
  /** The brand's storefront domain, so picked links are the public ones. */
  storeUrl: string;
}) {
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openTarget, setOpenTarget] = useState<number | null>(null);
  const [openProduct, setOpenProduct] = useState<number | null>(null);
  const [draft, setDraft, syncDraft] = useAutosave(
    block ?? EMPTY_BLOCK,
    (next) => onSave(next),
    { isSaving },
  );

  const campaign = readCampaign(blockKey, draft);
  /** Every edit stamps `updatedAt`, so the list can sort by last touched. */
  const nextBlock = (next: Partial<Omit<CampaignEntry, "key">>) =>
    buildCampaignBlock(blockKey, {
      ...campaign,
      ...next,
      updatedAt: new Date().toISOString(),
    });

  const patch = (next: Partial<Omit<CampaignEntry, "key">>) =>
    setDraft(nextBlock(next));

  /**
   * Picking from a closed set is already the final value — there is no next
   * keystroke to wait for. Debouncing it only widens the window in which an
   * external re-seed can land on top of the click, so these save at once.
   */
  const commit = (next: Partial<Omit<CampaignEntry, "key">>) => {
    const data = nextBlock(next);
    syncDraft(data);
    onSave(data);
  };

  const targets = readCampaignTargets(campaign.intent.targets);
  const products = readCampaignProducts(campaign.intent.products);

  const setTargets = (next: CampaignTarget[]) =>
    commit({ intent: { ...campaign.intent, targets: next } });
  const setProducts = (next: CampaignProduct[]) =>
    commit({ intent: { ...campaign.intent, products: next } });

  const withTarget = (index: number, change: Partial<CampaignTarget>) =>
    targets.map((target, i) =>
      i === index ? { ...target, ...change } : target,
    );
  const patchTarget = (index: number, change: Partial<CampaignTarget>) =>
    patch({
      intent: { ...campaign.intent, targets: withTarget(index, change) },
    });
  const commitTarget = (index: number, change: Partial<CampaignTarget>) =>
    setTargets(withTarget(index, change));

  /** A new entry opens straight away — nobody adds a row to leave it closed. */
  const addTarget = (seed: Partial<CampaignTarget>) => {
    setTargets([
      ...targets,
      { kind: "category", id: "", name: "", url: "", description: "", ...seed },
    ]);
    setOpenTarget(targets.length);
  };
  const removeTarget = (index: number) => {
    setTargets(targets.filter((_, i) => i !== index));
    setOpenTarget((open) => (open === null || open < index ? open : null));
  };

  const addProduct = () => {
    setProducts([
      ...products,
      { id: "", name: "", url: "", images: [], category: "", description: "" },
    ]);
    setOpenProduct(products.length);
  };
  const removeProduct = (index: number) => {
    setProducts(products.filter((_, i) => i !== index));
    setOpenProduct((open) => (open === null || open < index ? open : null));
  };

  const patchProduct = (index: number, change: Partial<CampaignProduct>) =>
    patch({
      intent: {
        ...campaign.intent,
        products: products.map((product, i) =>
          i === index ? { ...product, ...change } : product,
        ),
      },
    });

  /**
   * The picker owns neither list: it reports a toggle and we keep the copy.
   * Matching on id alone means a hand-typed product (no id) is never touched
   * by the picker, which is what someone who typed it would expect.
   */
  const togglePicked = (option: ProductPickerOption, selected: boolean) => {
    if (!selected) {
      setProducts(products.filter((product) => product.id !== option.id));
      return;
    }
    if (products.some((product) => product.id === option.id)) return;
    setProducts([
      ...products,
      {
        id: option.id,
        name: option.label,
        url: reHome(option.url, storeUrl),
        images: (option.images ?? []).slice(0, MAX_CAMPAIGN_PRODUCT_IMAGES),
        category: option.category ?? "",
        description: option.description ?? "",
      },
    ]);
  };

  return (
    <div className="min-w-0 max-w-3xl space-y-6 px-8 py-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="campaign-name">
            {t("sandbox.campaigns.nameLabel")}
          </Label>
          <Input
            id="campaign-name"
            value={campaign.name}
            placeholder={t("sandbox.campaigns.namePlaceholder")}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mt-6 shrink-0"
            aria-label={t("sandbox.campaigns.close")}
            onClick={onClose}
          >
            <X size={14} />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <div className="space-y-1.5">
          <Label>{t("sandbox.campaigns.statusLabel")}</Label>
          <PickList
            options={CAMPAIGN_STATUSES.map((s) => t(CAMPAIGN_STATUS_LABEL[s]))}
            value={t(CAMPAIGN_STATUS_LABEL[campaign.status])}
            onChange={(label) => {
              const next = CAMPAIGN_STATUSES.find(
                (s) => t(CAMPAIGN_STATUS_LABEL[s]) === label,
              );
              if (next) commit({ status: next });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("sandbox.campaigns.periodLabel")}</Label>
          <PeriodPicker
            period={campaign.period}
            onChange={(period) => patch({ period })}
          />
        </div>
      </div>

      <section className="space-y-2">
        <div className="flex items-center gap-1">
          <Label>{t("sandbox.campaigns.triggerLabel")}</Label>
          <OptionHelp
            label={t("sandbox.campaigns.triggerHelpLabel")}
            options={CAMPAIGN_TRIGGERS.map((v) => ({
              name: t(CAMPAIGN_TRIGGER_LABEL[v]),
              help: t(TRIGGER_HELP[v]),
            }))}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.triggerHint")}
        </p>
        <PickList
          options={CAMPAIGN_TRIGGERS.map((v) => t(CAMPAIGN_TRIGGER_LABEL[v]))}
          value={t(CAMPAIGN_TRIGGER_LABEL[campaign.trigger.type])}
          onChange={(label) => {
            const next = CAMPAIGN_TRIGGERS.find(
              (v) => t(CAMPAIGN_TRIGGER_LABEL[v]) === label,
            );
            if (next) {
              commit({ trigger: { ...campaign.trigger, type: next } });
            }
          }}
        />
        <Textarea
          value={campaign.trigger.note}
          rows={3}
          placeholder={t("sandbox.campaigns.triggerNotePlaceholder")}
          onChange={(e) =>
            patch({ trigger: { ...campaign.trigger, note: e.target.value } })
          }
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-1">
          <Label>{t("sandbox.campaigns.objectiveLabel")}</Label>
          <OptionHelp
            label={t("sandbox.campaigns.objectiveHelpLabel")}
            options={CAMPAIGN_OBJECTIVES.map((v) => {
              const facets = OBJECTIVE_FACETS[v];
              const note = OBJECTIVE_NOTE[v];
              return {
                name: t(OBJECTIVE_LABEL[v]),
                help: t(OBJECTIVE_HELP[v]),
                facets: [
                  {
                    label: t("sandbox.campaigns.facetContent"),
                    value: t(facets.content),
                  },
                  {
                    label: t("sandbox.campaigns.facetProduct"),
                    value: t(facets.product),
                  },
                  {
                    label: t("sandbox.campaigns.facetCta"),
                    value: t(facets.cta),
                  },
                  {
                    label: t("sandbox.campaigns.facetMetric"),
                    value: t(facets.metric),
                  },
                ],
                note: note ? t(note) : undefined,
              };
            })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.objectiveHint")}
        </p>
        <PickList
          options={CAMPAIGN_OBJECTIVES.map((v) => t(OBJECTIVE_LABEL[v]))}
          value={t(OBJECTIVE_LABEL[campaign.intent.objective])}
          onChange={(label) => {
            const next = CAMPAIGN_OBJECTIVES.find(
              (v) => t(OBJECTIVE_LABEL[v]) === label,
            );
            if (next) {
              commit({ intent: { ...campaign.intent, objective: next } });
            }
          }}
        />
      </section>

      <section className="space-y-2">
        <Label>{t("sandbox.campaigns.targetsLabel")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.targetsHint")}
        </p>
        {targets.length > 0 && (
          <CollapsibleList>
            {targets.map((target, index) => (
              <CollapsibleRow
                key={index}
                open={openTarget === index}
                onToggle={() =>
                  setOpenTarget(openTarget === index ? null : index)
                }
                title={target.name}
                untitledLabel={t("sandbox.campaigns.untitledTarget")}
                removeLabel={t("sandbox.campaigns.removeTarget")}
                onRemove={() => removeTarget(index)}
                leading={
                  <Badge variant="secondary" className="shrink-0">
                    {t(TARGET_KIND_LABEL[target.kind])}
                  </Badge>
                }
              >
                <div className="space-y-2 border-t px-3 py-3">
                  <PickList
                    options={CAMPAIGN_TARGET_KINDS.map((k) =>
                      t(TARGET_KIND_LABEL[k]),
                    )}
                    value={t(TARGET_KIND_LABEL[target.kind])}
                    onChange={(label) => {
                      const kind = CAMPAIGN_TARGET_KINDS.find(
                        (k) => t(TARGET_KIND_LABEL[k]) === label,
                      );
                      // A collection is identified by its id, not an address —
                      // a URL carried over from a category would be a dead link.
                      if (kind) {
                        commitTarget(
                          index,
                          kind === "collection" ? { kind, url: "" } : { kind },
                        );
                      }
                    }}
                  />
                  <Input
                    value={target.name}
                    placeholder={t("sandbox.campaigns.targetNamePlaceholder")}
                    onChange={(e) =>
                      patchTarget(index, { name: e.target.value })
                    }
                    className="h-9"
                  />
                  {target.kind !== "collection" && (
                    <Input
                      value={target.url}
                      placeholder={t("sandbox.campaigns.targetUrlPlaceholder")}
                      onChange={(e) =>
                        patchTarget(index, { url: e.target.value })
                      }
                      className="h-9"
                    />
                  )}
                  <Input
                    value={target.id}
                    placeholder={t(
                      target.kind === "collection"
                        ? "sandbox.campaigns.targetCollectionIdPlaceholder"
                        : "sandbox.campaigns.targetIdPlaceholder",
                    )}
                    onChange={(e) => patchTarget(index, { id: e.target.value })}
                    className="h-9"
                  />
                  <Textarea
                    value={target.description}
                    rows={2}
                    placeholder={t(
                      "sandbox.campaigns.targetDescriptionPlaceholder",
                    )}
                    onChange={(e) =>
                      patchTarget(index, { description: e.target.value })
                    }
                  />
                  {target.kind !== "collection" && !target.url.trim() && (
                    <p className="text-xs text-warning">
                      {t("sandbox.campaigns.targetUrlRequired")}
                    </p>
                  )}
                </div>
              </CollapsibleRow>
            ))}
          </CollapsibleList>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {sandboxRef && (
            <CategoryTargetPicker
              sandboxRef={sandboxRef}
              storeUrl={storeUrl}
              onPick={(picked) => addTarget(picked)}
            />
          )}
          <AddButton
            label={t("sandbox.campaigns.addTarget")}
            onClick={() => addTarget({})}
          />
        </div>
      </section>

      <section className="space-y-2">
        <Label>{t("sandbox.campaigns.productsLabel")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.productsHint")}
        </p>
        {products.length > 0 && (
          <CollapsibleList>
            {products.map((product, index) => (
              <CollapsibleRow
                key={`${product.id}-${index}`}
                open={openProduct === index}
                onToggle={() =>
                  setOpenProduct(openProduct === index ? null : index)
                }
                title={product.name}
                untitledLabel={t("sandbox.campaigns.untitledProduct")}
                removeLabel={t("sandbox.campaigns.removeProduct")}
                onRemove={() => removeProduct(index)}
                leading={
                  product.images[0] ? (
                    <img
                      src={product.images[0]}
                      alt=""
                      className="size-6 shrink-0 rounded border object-cover"
                    />
                  ) : (
                    <div className="size-6 shrink-0 rounded border bg-muted" />
                  )
                }
              >
                <div className="space-y-2 border-t px-3 py-3">
                  <Input
                    value={product.name}
                    placeholder={t("sandbox.campaigns.productNamePlaceholder")}
                    onChange={(e) =>
                      patchProduct(index, { name: e.target.value })
                    }
                    className="h-9"
                  />
                  <Input
                    value={product.url}
                    placeholder={t("sandbox.campaigns.productUrlPlaceholder")}
                    onChange={(e) =>
                      patchProduct(index, { url: e.target.value })
                    }
                    className="h-9"
                  />
                  <div className="flex gap-2">
                    <Input
                      value={product.id}
                      placeholder={t("sandbox.campaigns.productIdPlaceholder")}
                      onChange={(e) =>
                        patchProduct(index, { id: e.target.value })
                      }
                      className="h-9"
                    />
                    <Input
                      value={product.category}
                      placeholder={t(
                        "sandbox.campaigns.productCategoryPlaceholder",
                      )}
                      onChange={(e) =>
                        patchProduct(index, { category: e.target.value })
                      }
                      className="h-9"
                    />
                  </div>
                  <Textarea
                    value={product.description}
                    rows={2}
                    placeholder={t(
                      "sandbox.campaigns.productDescriptionPlaceholder",
                    )}
                    onChange={(e) =>
                      patchProduct(index, { description: e.target.value })
                    }
                  />
                  <ProductImages
                    images={product.images}
                    idPrefix={`${blockKey}-product-${index}`}
                    sandbox={sandboxRef}
                    onChange={(images) => patchProduct(index, { images })}
                  />
                </div>
              </CollapsibleRow>
            ))}
          </CollapsibleList>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {sandboxRef && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPickerOpen(true)}
            >
              <SearchSm size={14} />
              {t("sandbox.campaigns.pickProducts")}
            </Button>
          )}
          <AddButton
            label={t("sandbox.campaigns.addProduct")}
            onClick={() => addProduct()}
          />
        </div>
        {sandboxRef && (
          <ProductPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            sandboxRef={sandboxRef}
            selectedIds={products.map((p) => p.id).filter(Boolean)}
            onChange={() => {}}
            onPicked={togglePicked}
          />
        )}
      </section>

      <section className="space-y-2">
        <Label>{t("sandbox.campaigns.keywordsLabel")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.keywordsHint")}
        </p>
        <TermsInput
          terms={campaign.intent.keywords}
          onChange={(keywords) =>
            patch({ intent: { ...campaign.intent, keywords } })
          }
          placeholder={t("sandbox.campaigns.keywordsPlaceholder")}
          removeLabel={t("sandbox.campaigns.removeKeyword")}
        />
      </section>

      <section className="space-y-2">
        <Label>{t("sandbox.campaigns.avoidLabel")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.avoidHint")}
        </p>
        <RuleList
          rules={normalizeBrandRules(campaign.guardrails.avoidComplements)}
          onChange={(avoidComplements) =>
            patch({ guardrails: { ...campaign.guardrails, avoidComplements } })
          }
          revision={0}
          idPrefix={`campaign-avoid-${blockKey}`}
          add={t("sandbox.campaigns.addAvoid")}
          namePlaceholder={t("sandbox.campaigns.avoidNamePlaceholder")}
          bodyPlaceholder={t("sandbox.campaigns.avoidBodyPlaceholder")}
        />
      </section>

      <section className="space-y-2">
        <Label htmlFor="campaign-tone">
          {t("sandbox.campaigns.toneLabel")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("sandbox.campaigns.toneHint")}
        </p>
        <Textarea
          id="campaign-tone"
          value={campaign.guardrails.toneOverrides}
          rows={3}
          placeholder={t("sandbox.campaigns.tonePlaceholder")}
          onChange={(e) =>
            patch({
              guardrails: {
                ...campaign.guardrails,
                toneOverrides: e.target.value,
              },
            })
          }
        />
      </section>

      <div className="border-t pt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <Trash01 size={14} />
          {t("sandbox.campaigns.remove")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Up to three images per product.
 *
 * Each slot is the Studio image field, the same one the post cover and the
 * author avatar use: it browses the org's assets, takes a pasted address and
 * accepts a drop. Rolling a plain URL input here would have meant the one place
 * in the product that cannot reach the images the brand already uploaded.
 */
function ProductImages({
  images,
  idPrefix,
  sandbox,
  onChange,
}: {
  images: string[];
  idPrefix: string;
  sandbox?: SandboxConfig | null;
  onChange: (images: string[]) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      {images.map((image, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <ImageField
              schema={{
                type: "string",
                format: "image-uri",
                title: t("sandbox.campaigns.productImageLabel"),
              }}
              value={image}
              onChange={(next) =>
                onChange(
                  images.map((v, i) => (i === index ? String(next ?? "") : v)),
                )
              }
              path={`${idPrefix}-image-${index}`}
              label=""
              sandbox={sandbox}
              compact
            />
          </div>
          <RemoveButton
            label={t("sandbox.campaigns.removeImage")}
            onClick={() => onChange(images.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      {images.length < MAX_CAMPAIGN_PRODUCT_IMAGES && (
        <AddButton
          label={t("sandbox.campaigns.addImage")}
          onClick={() => onChange([...images, ""])}
        />
      )}
    </div>
  );
}

/**
 * Fills a category target from the store's own tree. A shortcut, never a gate:
 * every field stays typable, which is the only thing that works for a
 * collection (no storefront here lists them) or a store that is not up.
 */
function CategoryTargetPicker({
  sandboxRef,
  storeUrl,
  onPick,
}: {
  sandboxRef: PreviewProxyRef;
  /** The brand's storefront domain; the tree reports the platform's. */
  storeUrl: string;
  onPick: (target: Partial<CampaignTarget>) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8">
          <SearchSm size={14} />
          {t("sandbox.campaigns.pickCategory")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <CategoryTreeList
          sandboxRef={sandboxRef}
          enabled={open}
          className="h-56"
          onSelect={(category) => {
            onPick({
              id: category.path,
              name: category.label,
              url: reHome(category.url, storeUrl),
            });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The legend for a closed set, on demand.
 *
 * An option may carry just a line (a trigger is self-evident once named) or the
 * breakdown an objective needs — what the post is about, how the product shows
 * up in it, how hard the CTA pushes, what you would measure. Those four are
 * what actually separate the objectives; without them "awareness" and
 * "education" are two words for the same shrug.
 */
function OptionHelp({
  label,
  options,
}: {
  label: string;
  options: {
    name: string;
    help: string;
    facets?: { label: string; value: string }[];
    /** Where this objective usually shows up, when it pairs with a trigger. */
    note?: string;
  }[];
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground"
          aria-label={label}
        >
          <HelpCircle size={14} />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <dl className="max-h-[70svh] space-y-5 overflow-y-auto pr-1">
          {options.map((option) => (
            <div key={option.name} className="space-y-1.5">
              <dt className="text-sm font-medium">{option.name}</dt>
              <dd className="space-y-1.5 text-sm text-muted-foreground">
                <p>{option.help}</p>
                {option.facets && (
                  <ul className="space-y-0.5">
                    {option.facets.map((facet) => (
                      <li key={facet.label}>
                        <span className="text-foreground">{facet.label}:</span>{" "}
                        {facet.value}
                      </li>
                    ))}
                  </ul>
                )}
                {option.note && <p className="italic">{option.note}</p>}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** Start and end as one range, both optional — a campaign may have no dates. */
function PeriodPicker({
  period,
  onChange,
}: {
  period: { start: string | null; end: string | null };
  onChange: (period: { start: string | null; end: string | null }) => void;
}) {
  const t = useT();
  const from = parseDay(period.start);
  const to = parseDay(period.end);
  const label =
    period.start || period.end
      ? `${period.start ?? "—"} / ${period.end ?? "—"}`
      : t("sandbox.campaigns.periodEmpty");

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-9">
            <CalendarDate size={14} />
            <span className="tabular-nums">{label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="range"
            selected={from || to ? { from, to } : undefined}
            onSelect={(range) =>
              onChange({
                start: range?.from ? isoDay(range.from) : null,
                end: range?.to ? isoDay(range.to) : null,
              })
            }
          />
        </PopoverContent>
      </Popover>
      {(period.start || period.end) && (
        <RemoveButton
          label={t("sandbox.campaigns.periodClear")}
          onClick={() => onChange({ start: null, end: null })}
        />
      )}
    </div>
  );
}
