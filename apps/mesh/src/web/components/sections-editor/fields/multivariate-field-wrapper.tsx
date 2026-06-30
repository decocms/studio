import { useState, type ReactNode } from "react";
import { Flag01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  SectionVariantList,
  type SectionVariantEntry,
} from "../section-variant-list";
import { MatcherPicker, extractMatchers } from "../matcher-picker";
import { formatMatcher } from "../format-matcher";
import { resolveSchema } from "../resolve-schema";
import { SchemaForm } from "../schema-form";
import { ALWAYS_MATCHER_RESOLVE_TYPE } from "../section-types";
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
  /** Extract the plain value from the current (possibly wrapped) value. */
  extractValue: (value: unknown) => unknown;
  /** Render the plain (non-multivariate) field. */
  renderPlainField: (props: FieldProps) => ReactNode;
  /** Render the inner field for a single variant value. */
  renderVariantField: (props: FieldProps) => ReactNode;
}

export function MultivariateFieldWrapper({
  multivariateResolveType,
  extractValue,
  renderPlainField,
  renderVariantField,
  ...props
}: MultivariateFieldWrapperProps) {
  const { value, onChange, meta, path } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (!isMultivariateWrapper(value)) {
    const plainValue = extractValue(value);
    return (
      <div className="relative grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 size-6 text-muted-foreground hover:text-foreground"
              aria-label="Add variant"
              onClick={() => {
                onChange(
                  wrapAsMultivariate(plainValue, multivariateResolveType),
                );
                setSelectedIndex(0);
              }}
            >
              <Flag01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add variant</TooltipContent>
        </Tooltip>
        {renderPlainField(props)}
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
      `Variant ${i + 1}`,
  }));

  const currentVariant = variants[safeIndex];
  const currentRule = (currentVariant?.rule ?? {}) as Record<string, unknown>;
  const currentRt = (currentRule.__resolveType as string) ?? "";
  const currentValue = currentVariant?.value;

  const matchers = meta ? extractMatchers(meta) : [];

  const ruleSchema = currentRt && meta ? resolveSchema(currentRt, meta) : null;
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
    const rule = resolveType
      ? { __resolveType: resolveType }
      : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE };
    onChange(updateVariantRule(wrapper, safeIndex, rule));
  };

  const handleRuleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    const newRule: Record<string, unknown> = currentRt
      ? { __resolveType: currentRt, ...next }
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

        {renderVariantField({
          ...props,
          value: currentValue,
          onChange: handleValueChange,
        })}
      </div>
    </div>
  );
}
