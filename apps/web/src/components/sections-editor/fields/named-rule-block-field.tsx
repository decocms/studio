import { useState, type ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import type { NamedRuleKind } from "../named-rules";
import {
  type NamedRuleFieldSupport,
  NamedRuleViewsLink,
  useNamedRuleFieldSupport,
} from "../named-rule-step";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";
import {
  namedRuleBlockFieldKinds,
  namedRuleBlockFieldValue,
} from "../named-rule-picker";

const NONE = "__none__";

/**
 * A section prop that reads the site's A/B tests or campaigns as a whole
 * (`Assignments`, `Record<string, boolean>`): the schema says `split-traffic`
 * or `calendar` fits it, and the field saves the reference to the saved
 * block, `{ "__resolveType": "experiments" }` or `"campaigns"`. The section
 * then gets each test as on/off for the visitor, or each campaign as running
 * or not. A block that doesn't exist yet is saved empty first.
 */
function NamedRuleBlockField({
  value,
  onChange,
  path,
  label,
  required,
  schema,
  sandbox,
  kinds,
  support,
}: FieldProps & {
  kinds: NamedRuleKind[];
  support: NamedRuleFieldSupport;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const current = namedRuleBlockFieldValue(value);
  const kindLabel = (kind: NamedRuleKind) =>
    kind === "experiments"
      ? t("sectionsEditor.namedRulePicker.fieldTests")
      : t("sectionsEditor.namedRulePicker.fieldCampaigns");
  const usable = (kind: NamedRuleKind) =>
    support.kinds.find((k) => k.kind === kind)?.state !== "conflict";

  const choose = async (next: string) => {
    if (next === NONE) {
      onChange(undefined);
      return;
    }
    const kind = next as NamedRuleKind;
    setPending(true);
    try {
      if (!(await support.ensureBlock(kind))) return;
    } finally {
      setPending(false);
    }
    onChange({ __resolveType: kind });
  };

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      <Select
        value={current ?? ""}
        onValueChange={(v) => void choose(v)}
        disabled={pending}
      >
        <SelectTrigger id={path} className="h-10 w-full min-w-0">
          <SelectValue
            placeholder={t("sectionsEditor.namedRulePicker.fieldPlaceholder")}
          />
        </SelectTrigger>
        <SelectContent>
          {!required && (
            <SelectItem value={NONE} className="text-muted-foreground">
              {t("sectionsEditor.namedRulePicker.fieldNone")}
            </SelectItem>
          )}
          {kinds.map((kind) => (
            <SelectItem key={kind} value={kind} disabled={!usable(kind)}>
              {kindLabel(kind)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {current === "experiments"
              ? t("sectionsEditor.namedRulePicker.fieldTestsHint")
              : t("sectionsEditor.namedRulePicker.fieldCampaignsHint")}
          </p>
          <NamedRuleViewsLink kind={current} />
        </div>
      )}
      {kinds.some((kind) => !usable(kind)) && (
        <p className="text-xs text-muted-foreground">
          {kinds
            .filter((kind) => !usable(kind))
            .map((kind) =>
              kind === "experiments"
                ? t("sectionsEditor.namedRulePicker.conflictTests")
                : t("sectionsEditor.namedRulePicker.conflictCampaigns"),
            )
            .join(" ")}
        </p>
      )}
    </div>
  );
}

/** The built-in types whose saved block a field can read as a whole. */
const NAMED_RULE_BLOCK_TYPES = new Set(["split-traffic", "calendar"]);

/**
 * Whether the schema lists a built-in a field can take as a whole. Cheap and
 * pure, so the form's dispatch asks before mounting the gate.
 */
export function fitsNamedRuleBlock(schema: FieldProps["schema"]): boolean {
  return (
    schema.type === "block-ref" &&
    !!schema.anyOfRefs?.some((ref) =>
      NAMED_RULE_BLOCK_TYPES.has(ref.resolveType),
    )
  );
}

/**
 * Shows {@link NamedRuleBlockField} when the editor offers named rules (a
 * v8 site whose schema has the built-ins) and the value is empty or such a
 * reference; any other case renders the field as before (`fallback`).
 */
export function NamedRuleBlockFieldGate({
  fallback,
  ...props
}: FieldProps & { fallback: (props: FieldProps) => ReactNode }) {
  const support = useNamedRuleFieldSupport();
  const kinds = support
    ? namedRuleBlockFieldKinds(props.schema, props.value, support.kinds)
    : [];
  if (!support || kinds.length === 0) return <>{fallback(props)}</>;
  return <NamedRuleBlockField {...props} kinds={kinds} support={support} />;
}
