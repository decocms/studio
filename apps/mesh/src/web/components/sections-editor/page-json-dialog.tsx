import { useState } from "react";
import { Copy01, CheckCircle } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";

interface PageJsonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageKey: string;
  decofile: Record<string, unknown>;
}

export function PageJsonDialog({
  open,
  onOpenChange,
  pageKey,
  decofile,
}: PageJsonDialogProps) {
  const [copied, setCopied] = useState(false);
  const pageData = decofile[pageKey];
  // A missing key would otherwise stringify to the literal "undefined".
  const json =
    pageData === undefined
      ? "// Page not found."
      : JSON.stringify(pageData, null, 2);

  const handleCopy = () => {
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-sm font-semibold">Page JSON</DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-7 gap-1.5 text-xs"
          >
            {copied ? <CheckCircle size={12} /> : <Copy01 size={12} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <pre className="p-4 text-xs font-mono text-foreground/90 whitespace-pre overflow-auto">
            {json}
          </pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
