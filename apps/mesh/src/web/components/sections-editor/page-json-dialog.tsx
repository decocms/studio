import { useState } from "react";
import { Copy01, CheckCircle } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { MonacoCodeEditor } from "@/web/components/monaco-editor";

interface PageJsonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageKey: string;
  decofile: Record<string, unknown>;
  /** Persist edited page JSON. Omit to render read-only. */
  onSave?: (data: unknown) => Promise<unknown>;
}

export function PageJsonDialog({
  open,
  onOpenChange,
  pageKey,
  decofile,
  onSave,
}: PageJsonDialogProps) {
  const pageData = decofile[pageKey];
  const missing = pageData === undefined;
  // A missing key would otherwise stringify to the literal "undefined".
  const initialJson = missing ? "" : JSON.stringify(pageData, null, 2);

  const [copied, setCopied] = useState(false);
  const [value, setValue] = useState(initialJson);
  const [saving, setSaving] = useState(false);
  const readOnly = !onSave || missing;
  const dirty = value !== initialJson;

  const handleCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSave = async (next: string) => {
    if (!onSave || saving) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch {
      toast.error("Invalid JSON — fix the syntax before saving.");
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      toast.success("Page JSON saved.");
      onOpenChange(false);
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-sm font-semibold">Page JSON</DialogTitle>
          <div className="flex items-center gap-2 mr-8">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-7 gap-1.5 text-xs"
            >
              {copied ? <CheckCircle size={12} /> : <Copy01 size={12} />}
              {copied ? "Copied" : "Copy"}
            </Button>
            {!readOnly && (
              <Button
                size="sm"
                onClick={() => handleSave(value)}
                disabled={!dirty || saving}
                className="h-7 text-xs"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </DialogHeader>
        {missing ? (
          <div className="p-4 text-xs font-mono text-foreground/60">
            // Page not found.
          </div>
        ) : (
          <div className="h-[70vh]">
            <MonacoCodeEditor
              code={initialJson}
              language="json"
              readOnly={readOnly}
              height="100%"
              onChange={(v) => setValue(v ?? "")}
              onSave={(v) => void handleSave(v)}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
