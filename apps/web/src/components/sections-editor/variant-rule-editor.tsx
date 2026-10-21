import {
  MatcherPicker,
  type MatcherEntry,
  type MatcherGlobalEntry,
  type NamedRulePickerProps,
} from "./matcher-picker";
import type { NamedRuleRowState } from "./named-rule-picker";
import { NamedRuleRow } from "./named-rule-step";
import { VariantRuleForm } from "./sections-editor-panels";
import { type LiveMeta, type SchemaProperty } from "./resolve-schema";
import type { SandboxConfig } from "./fields/field-props";

/**
 * Matcher picker + variant rule form, shared by the page-variant and
 * section-variant rule editors. Caller owns the resolveType/formValue state
 * and any surrounding chrome (label, collapse toggle, disabled overlay).
 */
export function VariantRuleEditor({
  currentRt,
  currentLabel,
  currentGlobalKey,
  matchers,
  globals,
  onSelect,
  onSelectGlobal,
  schema,
  formValue,
  onChange,
  formKey,
  formWrapperClassName,
  meta,
  decofile,
  onSaveReferencedBlock,
  sandbox,
  named,
  namedRow,
}: {
  currentRt: string;
  currentLabel: string;
  currentGlobalKey?: string;
  matchers: MatcherEntry[];
  globals: MatcherGlobalEntry[];
  onSelect: (resolveType: string) => void;
  onSelectGlobal: (blockKey: string) => void;
  schema: SchemaProperty | null;
  formValue: Record<string, unknown> | null;
  onChange: (v: unknown) => void;
  formKey: string;
  formWrapperClassName: string;
  meta?: LiveMeta;
  decofile?: Record<string, unknown>;
  onSaveReferencedBlock?: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
  sandbox?: SandboxConfig | null;
  /** v8: tests and campaigns by name in the picker. */
  named?: NamedRulePickerProps;
  /**
   * The rule names a test or campaign (or is an inline date): a locked row
   * replaces the free-text form, so the name only changes through the picker.
   */
  namedRow?: NamedRuleRowState | null;
}) {
  return (
    <>
      <MatcherPicker
        currentRt={currentRt}
        currentLabel={currentLabel}
        currentGlobalKey={currentGlobalKey}
        matchers={matchers}
        globals={globals}
        onSelect={onSelect}
        onSelectGlobal={onSelectGlobal}
        named={named}
      />
      {named && namedRow && !currentGlobalKey ? (
        <div className={formWrapperClassName}>
          <NamedRuleRow
            kind={namedRow.kind}
            name={namedRow.name}
            summary={namedRow.summary}
            missing={namedRow.missing}
            inlineDate={namedRow.inlineDate}
          />
        </div>
      ) : (
        schema &&
        formValue && (
          <div className={formWrapperClassName}>
            <VariantRuleForm
              key={formKey}
              schema={schema}
              value={formValue}
              onChange={onChange}
              meta={meta}
              decofile={decofile}
              onSaveReferencedBlock={onSaveReferencedBlock}
              sandbox={sandbox}
            />
          </div>
        )
      )}
    </>
  );
}
