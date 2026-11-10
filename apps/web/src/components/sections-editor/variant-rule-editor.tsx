import {
  MatcherPicker,
  type MatcherEntry,
  type MatcherGlobalEntry,
  type NamedRulePickerProps,
} from "./matcher-picker";
import { useEffect, useState } from "react";
import {
  missingNamedRuleWithin,
  type NamedRulePick,
  type NamedRuleRowState,
  newNameProblem,
} from "./named-rule-picker";
import { useT } from "@/i18n/use-t.ts";
import { NamedRuleCreateForm, NamedRuleRow } from "./named-rule-step";
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
  rule,
  defaultsOnCreateOnly,
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
  /** A section variant's rule edits the stored rule (see `SchemaForm`). */
  defaultsOnCreateOnly?: boolean;
  /** v8: tests and campaigns by name in the picker. */
  named?: NamedRulePickerProps;
  /**
   * The rule names a test or campaign (or is an inline date): a locked row
   * replaces the free-text form, so the name only changes through the picker.
   */
  namedRow?: NamedRuleRowState | null;
  /**
   * The variant's rule as stored, so a test or campaign it names inside (a
   * `multi`, a saved rule) that isn't there is pointed out.
   */
  rule?: unknown;
}) {
  const t = useT();
  // The create form belongs to the variant and name it was opened for:
  // switching variants (this editor isn't remounted) closes it, so a pick
  // never lands on a variant the form wasn't opened from.
  const createFor = namedRow
    ? `${formKey}\u0000${namedRow.kind}\u0000${namedRow.name}`
    : null;
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  if (creatingFor !== null && creatingFor !== createFor) setCreatingFor(null);
  const creating = creatingFor !== null && creatingFor === createFor;
  // On a hosted draft the tests and campaigns blocks are only the index's
  // stubs until they are loaded (a rule naming a test doesn't point at the
  // block, so opening the page doesn't load it): every name looks missing.
  // A name is said to be missing, and offered to create, only once they are
  // loaded, and the editor asks for them as soon as it would say so.
  const namesLoaded = !named?.load || named.load.ready;
  const seemsMissingWithin = named
    ? missingNamedRuleWithin(rule, named.kinds, decofile)
    : null;
  const seemsMissing = !!namedRow?.missing || seemsMissingWithin !== null;
  const requestNames = named?.load?.request;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- loads the blocks the row reads once it would call a name missing, as a view loads what it opens (hosted-content.ts)
  useEffect(() => {
    if (seemsMissing && !namesLoaded) requestNames?.();
  }, [seemsMissing, namesLoaded, requestNames]);
  const missingWithin = namesLoaded ? seemsMissingWithin : null;
  const rowMissing = !!namedRow?.missing && namesLoaded;
  // A name the rule uses but the site doesn't have can be created right
  // here, as the picker would, when its kind takes new names.
  const rowKind =
    named && namedRow
      ? named.kinds.find((k) => k.kind === namedRow.kind)
      : undefined;
  const existingNames = rowKind ? rowKind.entries.map((e) => e.name) : [];
  const canCreate =
    !!named &&
    !!namedRow &&
    rowMissing &&
    !namedRow.inlineDate &&
    !!rowKind &&
    rowKind.state !== "conflict" &&
    newNameProblem(namedRow.name, existingNames) === null;
  const create = async (pick: NamedRulePick) => {
    if (!named) return;
    setCreatePending(true);
    try {
      await named.onPick(pick);
    } finally {
      setCreatePending(false);
    }
    setCreatingFor(null);
  };
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
          {canCreate && creating ? (
            <div className="rounded-[var(--studio-control-radius,var(--radius-md))] border border-border/80">
              <NamedRuleCreateForm
                key={createFor ?? ""}
                kind={namedRow.kind}
                initialName={namedRow.name}
                existingNames={existingNames}
                pending={createPending}
                submitLabel={t("sectionsEditor.namedRules.create")}
                dismiss="cancel"
                onBack={() => setCreatingFor(null)}
                onSubmit={(pick) => void create(pick)}
              />
            </div>
          ) : (
            <NamedRuleRow
              kind={namedRow.kind}
              name={namedRow.name}
              summary={namedRow.summary}
              missing={rowMissing}
              conflict={namedRow.conflict}
              inlineDate={namedRow.inlineDate}
              {...(canCreate
                ? { onCreate: () => setCreatingFor(createFor) }
                : {})}
            />
          )}
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
              defaultsOnCreateOnly={defaultsOnCreateOnly}
            />
          </div>
        )
      )}
      {missingWithin && (
        <p
          className="text-xs text-foreground"
          data-testid="named-rule-missing-within"
        >
          {missingWithin === "experiments"
            ? t("sectionsEditor.namedRulePicker.missingTestWithin")
            : t("sectionsEditor.namedRulePicker.missingCampaignWithin")}
        </p>
      )}
    </>
  );
}
