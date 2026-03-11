import { Button } from "@deco/ui/components/button.tsx";
import { Upload01, X } from "@untitledui/icons";
import { useRef } from "react";
import { toast } from "sonner";

export function LogoUpload({
  value,
  onChange,
  name,
  disabled,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  name?: string;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        toast.error("Image must be smaller than 2MB");
        return;
      }

      const reader = new FileReader();

      reader.onerror = () => {
        const error = reader.error;
        console.error("FileReader error:", error);
        toast.error(
          error?.message || "Failed to read image file. Please try again.",
        );
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      };

      reader.onloadend = () => {
        if (reader.readyState === FileReader.DONE && reader.result) {
          onChange(reader.result as string);
        }
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      };

      reader.readAsDataURL(file);
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
  };

  return (
    <div className="flex items-start gap-4">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        onChange={handleFileChange}
        disabled={disabled}
      />

      {value ? (
        <div className="relative group">
          <div className="h-20 w-20 rounded-lg border border-border bg-muted/20 overflow-hidden">
            <img
              src={value}
              alt={name || "Logo"}
              className="w-full h-full object-cover"
            />
          </div>
          <button
            type="button"
            onClick={handleRemove}
            disabled={disabled}
            className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={disabled}
          className="h-20 w-20 rounded-lg border-2 border-dashed border-border hover:border-foreground/50 hover:bg-accent/50 transition-colors flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
        >
          <Upload01 className="h-5 w-5" />
          <span className="text-xs">Upload</span>
        </button>
      )}

      <div className="flex-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleClick}
          disabled={disabled}
          className="mb-2"
        >
          {value ? "Change Logo" : "Upload Logo"}
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={disabled}
            className="ml-2"
          >
            Remove
          </Button>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Recommended: Square image, at least 200x200px. Max 2MB.
        </p>
      </div>
    </div>
  );
}
