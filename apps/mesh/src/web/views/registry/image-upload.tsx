import { useRef, useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  ImagePlus,
  RefreshCcw01,
  Trash01,
  Link01,
  Loading01,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  onFileUpload: (file: File) => void | Promise<void>;
  error?: string;
  isUploading?: boolean;
}

export function ImageUpload({
  value,
  onChange,
  onFileUpload,
  error,
  isUploading = false,
}: ImageUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    if (!isUploading) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    if (isUploading) return;
    const file = event.dataTransfer.files[0];
    if (file) {
      await onFileUpload(file);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file && !isUploading) {
      await onFileUpload(file);
    }
    // Reset input so same file can be re-selected
    event.target.value = "";
  };

  const hasImage = value.length > 0;

  return (
    <div className="grid gap-1.5">
      <Label>Image</Label>

      {hasImage ? (
        /* ── With image: preview + actions ── */
        <div className="relative group min-h-[180px] rounded-xl border border-border overflow-hidden bg-muted/10">
          <div className="flex items-center gap-3 p-3 h-full">
            <div className="size-20 rounded-lg border border-border bg-muted/20 overflow-hidden shrink-0">
              <img
                src={value}
                alt="Preview"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground truncate">{value}</p>
              <div className="flex items-center gap-2 mt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                >
                  <RefreshCcw01 className="size-3" />
                  Change
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => {
                    onChange("");
                    setShowUrlInput(false);
                  }}
                  disabled={isUploading}
                >
                  <Trash01 className="size-3" />
                  Remove
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : isUploading ? (
        /* ── Uploading state ── */
        <div className="relative min-h-[180px] rounded-xl border border-border bg-muted/10 flex flex-col items-center justify-center gap-3">
          <Loading01 className="size-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Uploading image...</p>
        </div>
      ) : (
        /* ── Without image: dropzone ── */
        <div
          className={cn(
            "relative min-h-[180px] rounded-xl border-2 border-dashed transition-colors cursor-pointer flex flex-col",
            isDragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-muted-foreground/40 hover:bg-muted/30",
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="flex flex-col items-center justify-center gap-2 py-6 px-4 flex-1">
            <div
              className={cn(
                "size-10 rounded-lg flex items-center justify-center transition-colors",
                isDragging
                  ? "bg-primary/10 text-primary"
                  : "bg-muted/50 text-muted-foreground",
              )}
            >
              <ImagePlus size={20} />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {isDragging ? "Drop image here" : "Click or drag to upload"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                PNG, JPG, SVG up to 2MB
              </p>
            </div>
          </div>

          {/* URL alternative */}
          {!showUrlInput ? (
            <div className="border-t border-border px-4 py-2">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full justify-center"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowUrlInput(true);
                }}
              >
                <Link01 className="size-3" />
                Or paste an image URL
              </button>
            </div>
          ) : (
            <div
              className="border-t border-border px-3 py-2"
              onClick={(event) => event.stopPropagation()}
            >
              <Input
                placeholder="https://example.com/logo.png"
                value={value}
                className="text-xs h-8"
                onChange={(event) => onChange(event.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
