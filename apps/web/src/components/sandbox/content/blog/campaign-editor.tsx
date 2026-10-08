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

import { Calendar } from "@decocms/ui/components/calendar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { CalendarDate, Trash01, X } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useAutosave } from "./use-autosave";
import { AddButton, PickList, RemoveButton } from "./blocks/primitives";
import { RuleList, TermsInput } from "./blocks/rule-list";
import {
  buildCampaignBlock,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  type CampaignEntry,
  type CampaignObjective,
  type CampaignStatus,
  type CampaignTarget,
  type CampaignTargetKind,
  type CampaignTrigger,
  normalizeBrandRules,
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
  product: "sandbox.campaigns.targetProduct",
  category: "sandbox.campaigns.targetCategory",
  collection: "sandbox.campaigns.targetCollection",
};

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
    status: "draft" as CampaignStatus,
    period: { start: null, end: null },
    trigger: { type: "seasonal" as CampaignTrigger, note: "" },
    intent: {
      objective: "awareness" as CampaignObjective,
      targets: [],
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
}: {
  blockKey: string;
  block: Record<string, unknown> | undefined;
  onSave: (data: Record<string, unknown>) => void;
  onRemove: () => void;
  /** Only the board shows a close affordance; the list pane is always open. */
  onClose?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useAutosave(block ?? {}, (next) => onSave(next));

  const campaign = readCampaign(blockKey, draft);
  /** Every edit stamps `updatedAt`, so the list can sort by last touched. */
  const patch = (next: Partial<Omit<CampaignEntry, "key">>) =>
    setDraft(
      buildCampaignBlock(blockKey, {
        ...campaign,
        ...next,
        updatedAt: new Date().toISOString(),
      }),
    );

  const targets = readCampaignTargets(campaign.intent.targets);
  const patchTarget = (index: number, change: Partial<CampaignTarget>) =>
    patch({
      intent: {
        ...campaign.intent,
        targets: targets.map((target, i) =>
          i === index ? { ...target, ...change } : target,
        ),
      },
    });

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
              if (next) patch({ status: next });
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
        <Label>{t("sandbox.campaigns.triggerLabel")}</Label>
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
              patch({ trigger: { ...campaign.trigger, type: next } });
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
        <Label>{t("sandbox.campaigns.objectiveLabel")}</Label>
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
              patch({ intent: { ...campaign.intent, objective: next } });
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
          <ul className="divide-y overflow-hidden rounded-lg border">
            {targets.map((target, index) => (
              <li key={index} className="space-y-2 bg-card p-3">
                <div className="flex items-center gap-2">
                  <PickList
                    options={CAMPAIGN_TARGET_KINDS.map((k) =>
                      t(TARGET_KIND_LABEL[k]),
                    )}
                    value={t(TARGET_KIND_LABEL[target.kind])}
                    onChange={(label) => {
                      const kind = CAMPAIGN_TARGET_KINDS.find(
                        (k) => t(TARGET_KIND_LABEL[k]) === label,
                      );
                      if (kind) patchTarget(index, { kind });
                    }}
                  />
                  <Input
                    value={target.label}
                    placeholder={t("sandbox.campaigns.targetLabelPlaceholder")}
                    onChange={(e) =>
                      patchTarget(index, { label: e.target.value })
                    }
                    className="h-9 min-w-0 flex-1"
                  />
                  <RemoveButton
                    label={t("sandbox.campaigns.removeTarget")}
                    onClick={() =>
                      patch({
                        intent: {
                          ...campaign.intent,
                          targets: targets.filter((_, i) => i !== index),
                        },
                      })
                    }
                  />
                </div>
                <Input
                  value={target.url}
                  placeholder={t("sandbox.campaigns.targetUrlPlaceholder")}
                  onChange={(e) => patchTarget(index, { url: e.target.value })}
                  className="h-9"
                />
                {!target.url.trim() && (
                  <p className="text-xs text-warning">
                    {t("sandbox.campaigns.targetUrlRequired")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <AddButton
          label={t("sandbox.campaigns.addTarget")}
          onClick={() =>
            patch({
              intent: {
                ...campaign.intent,
                targets: [...targets, { kind: "product", url: "", label: "" }],
              },
            })
          }
        />
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
