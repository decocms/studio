/**
 * Mock CMS editor for the demo board. Opens from a task's PR card and
 * shows a sandboxed storefront preview plus a content form, with a
 * scripted publish flow driven by the demo store.
 */

import { sleep } from "@decocms/std";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Check, Loading01 } from "@untitledui/icons";
import type { DemoTask } from "./data";
import { publishTask } from "./store";

export function CmsEditorDialog({
  task,
  open,
  onClose,
}: {
  task: DemoTask;
  open: boolean;
  onClose: () => void;
}) {
  const fix = task.cms;
  const previewUrl = `https://preview-${task.key.toLowerCase()}.sandbox.deco.site`;

  const handlePublish = async () => {
    await publishTask(task.id);
    await sleep(800);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogTitle className="sr-only">Edit {task.key}</DialogTitle>

        <Tabs
          defaultValue="preview"
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="flex items-center gap-3 border-b border-border px-5 py-3">
            <span className="text-xs font-medium text-muted-foreground">
              {task.key}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600">
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  Sandbox preview
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Changes run in an isolated sandbox until published
              </TooltipContent>
            </Tooltip>

            <TabsList className="h-8 rounded-lg">
              <TabsTrigger value="preview" className="rounded-md px-3 text-xs">
                Preview
              </TabsTrigger>
              <TabsTrigger value="content" className="rounded-md px-3 text-xs">
                Content
              </TabsTrigger>
            </TabsList>

            <div className="ml-auto">
              {task.publishState === "published" ? (
                <Button size="sm" disabled className="gap-1.5">
                  <Check size={14} className="text-green-500" />
                  Published
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={task.publishState === "publishing"}
                  onClick={() => void handlePublish()}
                >
                  {task.publishState === "publishing" ? (
                    <>
                      <Loading01 size={14} className="animate-spin" />
                      Publishing...
                    </>
                  ) : (
                    "Publish"
                  )}
                </Button>
              )}
            </div>
          </div>

          <TabsContent
            value="preview"
            className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-6"
          >
            <div className="mx-auto flex max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="flex items-center gap-3 border-b border-border bg-muted/60 px-4 py-2.5">
                <span className="flex gap-1.5">
                  <span className="size-2.5 rounded-full bg-red-400" />
                  <span className="size-2.5 rounded-full bg-amber-400" />
                  <span className="size-2.5 rounded-full bg-green-400" />
                </span>
                <span className="flex-1 truncate rounded-md bg-background px-3 py-1 text-[11px] text-muted-foreground">
                  {previewUrl}
                </span>
              </div>

              <div className="flex flex-col gap-6 p-8 sm:flex-row">
                <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground/60 sm:w-64">
                  Product image
                </div>
                <div className="flex flex-1 flex-col gap-3">
                  <h3 className="text-lg font-semibold text-foreground">
                    Washed linen shirt
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Garment-dyed, pre-shrunk 100% linen in washed indigo.
                  </p>
                  <span className="text-xl font-semibold text-foreground">
                    $88
                  </span>
                  <button
                    type="button"
                    className="w-fit rounded-lg bg-foreground px-5 py-2 text-sm font-medium text-background"
                  >
                    Add to cart
                  </button>

                  {fix && (
                    <div className="relative mt-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3">
                      <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1 rounded-full bg-green-600 px-2 py-0.5 text-[10px] font-medium text-white">
                        <Check size={10} />
                        Fixed by Deco
                      </span>
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {fix.fieldLabel}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-foreground">
                        {fix.fieldValue}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent
            value="content"
            className="min-h-0 flex-1 overflow-y-auto p-6"
          >
            <div className="mx-auto grid max-w-3xl grid-cols-[160px_1fr] gap-x-6 gap-y-5 text-sm">
              <FieldLabel>Product title</FieldLabel>
              <FieldValue>Washed linen shirt</FieldValue>

              <FieldLabel>Price</FieldLabel>
              <FieldValue>$88.00</FieldValue>

              {fix && (
                <>
                  <FieldLabel>
                    {fix.fieldLabel}
                    <Badge className="ml-2 bg-green-500/10 text-[10px] text-green-600">
                      updated
                    </Badge>
                  </FieldLabel>
                  <textarea
                    readOnly
                    value={fix.fieldValue}
                    rows={3}
                    className="w-full resize-none rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground outline-none"
                  />
                </>
              )}

              <FieldLabel>Status</FieldLabel>
              <FieldValue>
                {task.published ? "Published" : "Draft in sandbox"}
              </FieldValue>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="pt-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function FieldValue({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
      {children}
    </span>
  );
}
