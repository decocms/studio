import { useState } from "react";
import { File02, Upload01, X } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { FilePickerDialog } from "@/web/components/file-picker/file-picker-dialog";
import type { FieldProps } from "./field-props";

export function FileField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const strValue = typeof value === "string" ? value : "";
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>
      {strValue ? (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
            <File02 size={16} className="text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{basename(strValue)}</p>
            <p className="text-xs text-muted-foreground truncate">{strValue}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            aria-label="Clear file"
          >
            <X size={14} />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/30 py-6 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground transition"
        >
          <File02 size={16} />
          <span>Pick or upload a file</span>
        </button>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={path}
          type="url"
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://..."
          className="h-10 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          className="h-10 shrink-0"
        >
          <Upload01 size={14} />
          {strValue ? "Replace" : "Browse"}
        </Button>
      </div>
      <FilePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="any"
        onSelect={(url) => onChange(url)}
      />
    </div>
  );
}

function basename(url: string): string {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/");
    return parts[parts.length - 1] || url;
  } catch {
    const parts = url.split("/");
    return parts[parts.length - 1] || url;
  }
}
