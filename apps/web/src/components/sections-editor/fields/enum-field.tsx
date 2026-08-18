import { useT } from "@/i18n/use-t.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import type { FieldProps } from "./field-props";
import {
  ENUM_CLEAR_SELECT_VALUE,
  enumOptionLabel,
  enumOptionToSelectValue,
  formValueToSelectValue,
  selectValueToFormValue,
} from "./enum-select-value";
import { FieldLabel } from "./field-label";

export function EnumField({
  schema,
  value,
  onChange,
  path,
  label,
  required,
  sandbox,
}: FieldProps) {
  const t = useT();
  const options = schema.enum ?? [];
  const selectValue = formValueToSelectValue(value, options);
  // Suppressed when "" is already an option: that is itself the empty choice.
  const showClearOption = !required && !options.some((opt) => opt === "");

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      <Select
        value={selectValue}
        onValueChange={(v) => onChange(selectValueToFormValue(v, options))}
      >
        <SelectTrigger id={path} className="h-10">
          <SelectValue
            placeholder={t("sectionsEditor.enumField.selectPlaceholder")}
          />
        </SelectTrigger>
        <SelectContent>
          {showClearOption && (
            <SelectItem
              value={ENUM_CLEAR_SELECT_VALUE}
              className="text-muted-foreground"
            >
              {t("sectionsEditor.enumField.clearOption")}
            </SelectItem>
          )}
          {options.map((opt) => {
            const itemValue = enumOptionToSelectValue(opt);
            return (
              <SelectItem key={itemValue} value={itemValue}>
                {enumOptionLabel(opt)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
