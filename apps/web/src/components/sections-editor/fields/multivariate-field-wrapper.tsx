import { useState, type ReactNode } from "react";
import { Flag01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
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
  extractMatcherGlobals,
  extractMatchers,
  type MatcherEntry,
} from "../matcher-picker";
import { formatMatcher } from "../format-matcher";
import {
  buildMatcherBlockData,
  getSavedMatcherBlockKey,
  isSavedMatcherBlockReference,
  readMatcherRuleFormState,
  resolveEffectiveMatcherRule,
  resolveVariantRuleLabel,
  seedMatcherRule,
} from "../matcher-rules";
import type { LiveMeta } from "../resolve-schema";
import { VariantRuleEditor } from "../variant-rule-editor";
import { VariantRenameDialog } from "../variant-rename-dialog";
import { ALWAYS_MATCHER_RESOLVE_TYPE } from "../section-types";
import { cachedResolveSchema } from "./resolved-schema-cache";
import type { VariantMatcherOps } from "../variant-matcher-rename";

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
import type { FieldProps } from "./field-props";

export interface MultivariateFieldWrapperProps extends FieldProps {
  multivariateResolveType: string;
  /** Render the inner field (used for both plain and variant values). */
  renderInnerField: (props: FieldProps) => ReactNode;
  /**
   * Block-store operations for naming a variant's matcher as a global block.
   * Only supplied on the top-level (global-block) surface, where the wrapper
   * value is the whole block; absent for nested fields, which hide Rename.
   */
  onVariantMatcherOp?: VariantMatcherOps;
}

export function MultivariateFieldWrapper({
  multivariateResolveType,
  renderInnerField,
  onVariantMatcherOp,
  ...props
}: MultivariateFieldWrapperProps) {
  const t = useT();
  const { value, onChange, meta, path, decofile } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [renameIndex, setRenameIndex] = useState<number | null>(null);
  const [renamePending, setRenamePending] = useState(false);

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
              <Flag01 size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("sectionsEditor.multivariateFieldWrapper.addVariant")}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  const wrapper = value as MultivariateWrapper;
  const variants = wrapper.variants;
  const safeIndex = Math.min(selectedIndex, variants.length - 1);

  const variantEntries: SectionVariantEntry[] = variants.map((v, i) => ({
    index: i,
    label:
      resolveVariantRuleLabel(
        v.rule as Record<string, unknown> | undefined,
        decofile ?? {},
        formatMatcher,
        meta,
      ) ||
      t("sectionsEditor.multivariateFieldWrapper.variantN", {
        n: String(i + 1),
      }),
  }));

  const currentVariant = variants[safeIndex];
  const currentRule = (currentVariant?.rule ?? {}) as Record<string, unknown>;
  // Set when the rule references a saved global block; edits then route to it.
  const currentGlobalKey =
    getSavedMatcherBlockKey(currentRule, decofile ?? {}, meta) ?? undefined;
  const { resolveType: currentRt, formValue: ruleFormValue } =
    readMatcherRuleFormState(currentRule, decofile ?? {}, meta);
  const currentValue = currentVariant?.value;

  const matchers = meta ? cachedExtractMatchers(meta) : [];
  const globals = meta && decofile ? extractMatcherGlobals(meta, decofile) : [];

  const ruleSchema =
    currentRt && meta ? cachedResolveSchema(currentRt, meta) : null;

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
    if (currentGlobalKey) {
      const block = (decofile?.[currentGlobalKey] ?? {}) as Record<
        string,
        unknown
      >;
      const displayName =
        typeof block.name === "string" ? block.name : currentGlobalKey;
      props.onSaveReferencedBlock?.(
        currentGlobalKey,
        buildMatcherBlockData(currentRt, next, displayName),
      );
      return;
    }
    const newRule: Record<string, unknown> = currentRt
      ? { ...next, __resolveType: currentRt }
      : { ...next };
    onChange(updateVariantRule(wrapper, safeIndex, newRule));
  };

  // Raw `props.value` (unlike the narrowed `value`) casts to a plain record.
  const wrapperRecord = props.value as Record<string, unknown>;

  const handleSelectGlobal = (blockKey: string) => {
    void onVariantMatcherOp?.selectGlobal(wrapperRecord, safeIndex, blockKey);
  };

  const handleRename = async (index: number, nextName: string) => {
    if (!onVariantMatcherOp) return;
    setRenamePending(true);
    try {
      await onVariantMatcherOp.rename(wrapperRecord, index, nextName);
    } finally {
      setRenamePending(false);
      setRenameIndex(null);
    }
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
        onRename={onVariantMatcherOp ? setRenameIndex : undefined}
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
          <VariantRuleEditor
            currentRt={currentRt}
            currentLabel={resolveVariantRuleLabel(
              currentRule,
              decofile ?? {},
              formatMatcher,
              meta,
            )}
            currentGlobalKey={currentGlobalKey}
            matchers={matchers}
            globals={globals}
            onSelect={handleRuleChange}
            onSelectGlobal={handleSelectGlobal}
            schema={ruleSchema}
            formValue={ruleFormValue}
            onChange={handleRuleFormChange}
            formKey={`${safeIndex}:${currentGlobalKey ?? currentRt}`}
            formWrapperClassName="pt-1"
            meta={meta}
            decofile={decofile}
            onSaveReferencedBlock={props.onSaveReferencedBlock}
            sandbox={props.sandbox}
          />
        </div>

        {renderInnerField({
          ...props,
          value: currentValue,
          onChange: handleValueChange,
        })}
      </div>

      {renameIndex !== null && (
        <VariantRenameDialog
          open
          initialName={
            isSavedMatcherBlockReference(
              variants[renameIndex]?.rule as
                | Record<string, unknown>
                | undefined,
              decofile ?? {},
              meta,
            )
              ? resolveVariantRuleLabel(
                  variants[renameIndex]?.rule as
                    | Record<string, unknown>
                    | undefined,
                  decofile ?? {},
                  formatMatcher,
                  meta,
                )
              : ""
          }
          autoLabel={formatMatcher(
            resolveEffectiveMatcherRule(
              variants[renameIndex]?.rule as
                | Record<string, unknown>
                | undefined,
              decofile ?? {},
              meta,
            ),
          )}
          isPending={renamePending}
          onSubmit={(name) => handleRename(renameIndex, name)}
          onOpenChange={(open) => {
            if (!open && !renamePending) setRenameIndex(null);
          }}
        />
      )}
    </div>
  );
}
