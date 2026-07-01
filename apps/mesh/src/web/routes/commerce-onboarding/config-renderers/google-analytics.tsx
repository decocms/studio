import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Loading01 } from "@untitledui/icons";
import { useState } from "react";
import { flattenGaOptions } from "../companion-config-core.ts";
import type { CompanionConfigRendererProps } from "./types.ts";

export function GoogleAnalyticsRenderer({
  currentValue,
  gaGroups,
  gaError,
  saving,
  error,
  onSave,
}: CompanionConfigRendererProps) {
  const saved = (currentValue.propertyId as string | undefined) ?? "";
  // Single property → auto-select as the initial value (still editable).
  const flat = flattenGaOptions(gaGroups);
  const initial = saved || (flat.length === 1 ? flat[0]!.value : "");
  const [selected, setSelected] = useState(initial);

  if (gaError || gaGroups.length === 0) {
    // Escape hatch: manual propertyId entry when listing failed/empty.
    return (
      <ConfigRow error={error}>
        <div className="flex flex-1 items-center gap-2">
          <Input
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            placeholder="properties/1234567"
            className="flex-1"
          />
          <SaveButton
            saving={saving}
            disabled={!selected}
            onClick={() => onSave({ propertyId: selected })}
          />
        </div>
      </ConfigRow>
    );
  }

  return (
    <ConfigRow error={error}>
      <div className="flex flex-1 items-center gap-2">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger size="sm" className="flex-1">
            <SelectValue placeholder="Select a property..." />
          </SelectTrigger>
          <SelectContent>
            {gaGroups.map((group) => (
              <SelectGroup key={group.account}>
                <SelectLabel>{group.account}</SelectLabel>
                {group.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <SaveButton
          saving={saving}
          disabled={!selected}
          onClick={() => onSave({ propertyId: selected })}
        />
      </div>
    </ConfigRow>
  );
}

function ConfigRow({
  children,
  error,
}: {
  children: React.ReactNode;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      {children}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SaveButton({
  saving,
  disabled,
  onClick,
}: {
  saving: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled || saving}
      onClick={onClick}
    >
      {saving ? <Loading01 size={16} className="animate-spin" /> : "Save"}
    </Button>
  );
}
