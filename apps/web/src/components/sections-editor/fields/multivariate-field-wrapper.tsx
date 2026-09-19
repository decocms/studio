import { useState, type ReactNode } from "react";
import { ChevronRight, LayersThree01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t";
import {
  SectionVariantList,
  type SectionVariantEntry,
} from "../section-variant-list";
import {
  MatcherPicker,
  extractMatchers,
  type MatcherEntry,
} from "../matcher-picker";
import { formatMatcher } from "../format-matcher";
import { seedMatcherRule } from "../matcher-rules";
import type { LiveMeta } from "../resolve-schema";
import { VariantRuleForm } from "../sections-editor-panels";
import { ALWAYS_MATCHER_RESOLVE_TYPE } from "../section-types";
import { cachedResolveSchema } from "./resolved-schema-cache";

// `meta` changes only on page load; `resolveType` changes only on rule picker
// selection — cache the matcher list per meta instance (WeakMap, so a stale
// meta's entries GC with it).
const matchersCache = new WeakMap<LiveMeta, MatcherEntry[]>();

function cachedExtractMatchers(meta: LiveMeta): MatcherEntry[] {
  let result = matchersCache.get(meta);
  if (!result) {
    result = extractMatchers(meta);
    matchersCache.set(meta, result);
  }
  return result;
}
import {
  appendVariant,
  deleteVariant,
  duplicateVariant,
  flattenMultivariate,
  isMultivariateWrapper,
  reorderVariant,
  selectedIndexAfterDelete,
  updateVariantRule,
  updateVariantValue,
  wrapAsMultivariate,
  type MultivariateWrapper,
} from "./media-variants";
import { editorRowClassName } from "../editor-list-row";
import type { FieldProps } from "./field-props";

export interface MultivariateFieldWrapperProps extends FieldProps {
  multivariateResolveType: string;
  /**
   * Set where this wrapper is one property among many: the field then reads as
   * a row you open, the way a multivariate section does, instead of stacking a
   * variant list and a rule on top of its neighbours. The section-level call
   * site leaves it off — there the wrapper already owns the panel.
   */
  asDestination?: boolean;
  /** Render the inner field (used for both plain and variant values). */
  renderInnerField: (props: FieldProps) => ReactNode;
}

export function MultivariateFieldWrapper({
  multivariateResolveType,
  renderInnerField,
  asDestination,
  ...props
}: MultivariateFieldWrapperProps) {
  const t = useT();
  const { value, onChange, meta, path, label, focused } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (!isMultivariateWrapper(value)) {
    return (
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        {renderInnerField(props)}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t(
                "sectionsEditor.multivariateFieldWrapper.addVariant",
              )}
              onClick={() => {
                onChange(wrapAsMultivariate(value, multivariateResolveType));
                setSelectedIndex(0);
              }}
            >
              <LayersThree01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("sectionsEditor.multivariateFieldWrapper.addVariant")}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  // Closed: one row that opens the variants, so a property with variants reads
  // the same as a section with variants. The crumb is the field's own label —
  // that is what the breadcrumb resolver matches to narrow back to this field.
  if (asDestination && !focused) {
    return (
      <button
        type="button"
        onClick={() =>
          props.onBreadcrumbChange?.([...(props.breadcrumbPath ?? []), label])
        }
        className={cn(
          editorRowClassName({
            className: "w-full cursor-pointer text-left",
          }),
        )}
      >
        <LayersThree01 className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t("sectionsEditor.multivariateFieldWrapper.variantsOf", { label })}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  const wrapper = value as MultivariateWrapper;
  const variants = wrapper.variants;
  const safeIndex = Math.min(selectedIndex, variants.length - 1);

  const variantEntries: SectionVariantEntry[] = variants.map((v, i) => ({
    index: i,
    label:
      formatMatcher(v.rule as Record<string, unknown> | undefined) ||
      t("sectionsEditor.multivariateFieldWrapper.variantN", {
        n: String(i + 1),
      }),
  }));

  const currentVariant = variants[safeIndex];
  const currentRule = (currentVariant?.rule ?? {}) as Record<string, unknown>;
  const currentRt = (currentRule.__resolveType as string) ?? "";
  const currentValue = currentVariant?.value;

  const matchers = meta ? cachedExtractMatchers(meta) : [];

  const ruleSchema =
    currentRt && meta ? cachedResolveSchema(currentRt, meta) : null;
  const { __resolveType: _, ...ruleFormValue } = currentRule;

  const handleFlatten = () => {
    onChange(flattenMultivariate(wrapper));
    setSelectedIndex(0);
  };

  const handleAdd = () => {
    const next = appendVariant(wrapper);
    onChange(next);
    setSelectedIndex(next.variants.length - 1);
  };

  const handleDelete = (index: number) => {
    const next = deleteVariant(wrapper, index);
    if (!next) return;
    onChange(next);
    setSelectedIndex(
      selectedIndexAfterDelete(safeIndex, index, next.variants.length),
    );
  };

  const handleDuplicate = (index: number) => {
    const next = duplicateVariant(wrapper, index);
    onChange(next);
    setSelectedIndex(index + 1);
  };

  const handleReorder = (from: number, to: number) => {
    const next = reorderVariant(wrapper, from, to);
    onChange(next);
    if (safeIndex === from) {
      setSelectedIndex(to);
    }
  };

  const handleRuleChange = (resolveType: string) => {
    // Seed union-matcher discriminants so accepting the default branch still
    // persists a valid rule (see seedMatcherRule).
    const rule = resolveType
      ? seedMatcherRule(resolveType, meta)
      : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE };
    onChange(updateVariantRule(wrapper, safeIndex, rule));
  };

  const handleRuleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    const newRule: Record<string, unknown> = currentRt
      ? { ...next, __resolveType: currentRt }
      : { ...next };
    onChange(updateVariantRule(wrapper, safeIndex, newRule));
  };

  const handleValueChange = (nextValue: unknown) => {
    onChange(updateVariantValue(wrapper, safeIndex, nextValue));
  };

  const listKey = `${path}-${wrapper.__resolveType}`;

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-0">
      <SectionVariantList
        listKey={listKey}
        variants={variantEntries}
        selectedIndex={safeIndex}
        onSelect={setSelectedIndex}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onRemoveAll={handleFlatten}
        onReorder={handleReorder}
        onAdd={handleAdd}
      />

      <div className="space-y-4 px-2 pt-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            {t("sectionsEditor.multivariateFieldWrapper.ruleLabel")}
          </Label>
          <MatcherPicker
            currentRt={currentRt}
            currentLabel={formatMatcher(currentRule)}
            matchers={matchers}
            onSelect={handleRuleChange}
          />
          {ruleSchema && (
            <div className="pt-1">
              <VariantRuleForm
                key={`${safeIndex}-${currentRt}`}
                schema={ruleSchema}
                value={ruleFormValue}
                onChange={handleRuleFormChange}
                meta={meta}
                decofile={props.decofile}
                onSaveReferencedBlock={props.onSaveReferencedBlock}
                sandbox={props.sandbox}
              />
            </div>
          )}
        </div>

        {renderInnerField({
          ...props,
          value: currentValue,
          onChange: handleValueChange,
        })}
      </div>
    </div>
  );
}
