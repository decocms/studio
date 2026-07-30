import { useState, type ReactNode } from "react";
import { Flag01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
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
import { SchemaForm } from "../schema-form";
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
  updateVariantRule,
  updateVariantValue,
  wrapAsMultivariate,
  type MultivariateWrapper,
} from "./media-variants";
import type { FieldProps } from "./field-props";

export interface MultivariateFieldWrapperProps extends FieldProps {
  multivariateResolveType: string;
  /** Render the inner field (used for both plain and variant values). */
  renderInnerField: (props: FieldProps) => ReactNode;
}

export function MultivariateFieldWrapper({
  multivariateResolveType,
  renderInnerField,
  ...props
}: MultivariateFieldWrapperProps) {
  const t = useT();
  const { value, onChange, meta, path } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (!isMultivariateWrapper(value)) {
    return (
      <div className="relative grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 size-6 text-muted-foreground hover:text-foreground"
              aria-label={t(
                "sectionsEditor.multivariateFieldWrapper.addVariant",
              )}
              onClick={() => {
                onChange(wrapAsMultivariate(value, multivariateResolveType));
                setSelectedIndex(0);
              }}
            >
              <Flag01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("sectionsEditor.multivariateFieldWrapper.addVariant")}
          </TooltipContent>
        </Tooltip>
        {renderInnerField(props)}
      </div>
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
    if (safeIndex >= next.variants.length) {
      setSelectedIndex(next.variants.length - 1);
    }
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
          <Label className="text-xs text-muted-foreground">Rule</Label>
          <MatcherPicker
            currentRt={currentRt}
            currentLabel={formatMatcher(currentRule)}
            matchers={matchers}
            onSelect={handleRuleChange}
          />
          {ruleSchema && (
            <div className="pt-1">
              <SchemaForm
                schema={ruleSchema}
                value={ruleFormValue}
                onChange={handleRuleFormChange}
                basePath=""
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
