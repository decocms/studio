import {
  MatcherPicker,
  type MatcherEntry,
  type MatcherGlobalEntry,
} from "./matcher-picker";
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
      />
      {schema && formValue && (
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
      )}
    </>
  );
}
