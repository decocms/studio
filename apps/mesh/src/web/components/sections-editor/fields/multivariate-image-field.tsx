import { useState } from "react";
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
import { ALWAYS_MATCHER_RESOLVE_TYPE } from "../section-types";
import { ImageField } from "./image-field";
import {
  appendMediaVariant,
  deleteMediaVariant,
  duplicateMediaVariant,
  flattenMediaMultivariate,
  isMediaMultivariateWrapper,
  reorderMediaVariant,
  updateMediaVariantRule,
  updateMediaVariantValue,
  wrapAsMediaMultivariate,
  type MediaMultivariateWrapper,
} from "./media-variants";
import { extractUrl } from "./extract-url";
import type { FieldProps } from "./field-props";

interface MultivariateImageFieldProps extends FieldProps {
  multivariateResolveType: string;
}

export function MultivariateImageField({
  multivariateResolveType,
  ...props
}: MultivariateImageFieldProps) {
  const { value, onChange, meta, path } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (!isMediaMultivariateWrapper(value)) {
    const strValue = extractUrl(value);
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
                  wrapAsMediaMultivariate(strValue, multivariateResolveType),
                );
                setSelectedIndex(0);
              }}
            >
              <Flag01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add variant</TooltipContent>
        </Tooltip>
        <ImageField {...props} />
      </div>
    );
  }

  const wrapper = value as MediaMultivariateWrapper;
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
  const currentUrl =
    typeof currentVariant?.value === "string" ? currentVariant.value : "";

  const matchers = meta ? extractMatchers(meta) : [];

  const handleFlatten = () => {
    onChange(flattenMediaMultivariate(wrapper));
    setSelectedIndex(0);
  };

  const handleAdd = () => {
    const next = appendMediaVariant(wrapper);
    onChange(next);
    setSelectedIndex(next.variants.length - 1);
  };

  const handleDelete = (index: number) => {
    const next = deleteMediaVariant(wrapper, index);
    if (!next) return;
    onChange(next);
    if (safeIndex >= next.variants.length) {
      setSelectedIndex(next.variants.length - 1);
    }
  };

  const handleDuplicate = (index: number) => {
    const next = duplicateMediaVariant(wrapper, index);
    onChange(next);
    setSelectedIndex(index + 1);
  };

  const handleReorder = (from: number, to: number) => {
    const next = reorderMediaVariant(wrapper, from, to);
    onChange(next);
    if (safeIndex === from) {
      setSelectedIndex(to);
    }
  };

  const handleRuleChange = (resolveType: string) => {
    const rule = resolveType
      ? { __resolveType: resolveType }
      : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE };
    onChange(updateMediaVariantRule(wrapper, safeIndex, rule));
  };

  const handleValueChange = (nextValue: unknown) => {
    const url =
      typeof nextValue === "string" ? nextValue : extractUrl(nextValue);
    onChange(updateMediaVariantValue(wrapper, safeIndex, url));
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
        </div>

        <ImageField
          {...props}
          value={currentUrl}
          onChange={handleValueChange}
        />
      </div>
    </div>
  );
}
