import { useState } from "react";
import { ArrowRight, SearchSm } from "@untitledui/icons";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  fillPathTemplate,
  stripSurroundingSlashes,
} from "@/components/sections-editor/page-path-utils";
import { useT } from "@/i18n/use-t.ts";
import type { BlogPathOption } from "./blog-path-options";

/**
 * A blog route param in the URL bar. Picking a post, category or author fills
 * every param of the route from that record, so a `:categoria`/`:slug` pair
 * never mixes two posts. Typing still sets just this param.
 */
export function BlogPathParamChip({
  paramName,
  template,
  value,
  options,
  onPick,
  onCommit,
}: {
  paramName: string;
  template: string;
  value: string;
  options: BlogPathOption[];
  onPick: (values: Record<string, string>) => void;
  onCommit: (value: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const paramLabel = `:${paramName}`;

  const term = search.trim().toLowerCase();
  const visible = term
    ? options.filter(
        (opt) =>
          opt.label.toLowerCase().includes(term) ||
          Object.values(opt.values).some((v) => v.toLowerCase().includes(term)),
      )
    : options;
  const rawTerm = stripSurroundingSlashes(search);

  const close = () => {
    setOpen(false);
    setSearch("");
  };

  return (
    <>
      {/* The URL-bar container toggles the pages dropdown on click, so the
          chip must not let clicks bubble. */}
      <button
        type="button"
        title={t("sandbox.pathParamPickerChip.buttonTitle", { paramLabel })}
        className="max-w-64 shrink-0 cursor-pointer truncate rounded-lg bg-special/15 px-1 py-0.5 text-xs text-special hover:bg-special/25"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {value || paramLabel}
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
      >
        <DialogContent
          className="flex h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:h-[520px] sm:max-w-[560px]"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {t("sandbox.pathParamPickerChip.pickValueTitle", { paramLabel })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
            <SearchSm size={16} className="shrink-0 text-foreground" />
            <span className="text-sm font-medium text-foreground">
              {t("sandbox.pathParamPickerChip.pickValueHeading")}{" "}
              <span className="rounded-sm bg-special/15 px-1 py-0.5 font-mono text-xs text-special">
                {paramLabel}
              </span>
            </span>
          </div>
          <Command shouldFilter={false} className="min-h-0 flex-1">
            <CommandInput
              autoFocus
              placeholder={t(
                "sandbox.pathParamPickerChip.searchBlogPlaceholder",
              )}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto">
              <CommandEmpty>
                {t("sandbox.pathParamPickerChip.noResults")}
              </CommandEmpty>
              {rawTerm && (
                <CommandGroup>
                  <CommandItem
                    value={`__raw__:${rawTerm}`}
                    className="gap-3 py-2"
                    onSelect={() => {
                      onCommit(rawTerm);
                      close();
                    }}
                  >
                    <ArrowRight
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {t("sandbox.pathParamPickerChip.useRawValue", {
                        rawTerm,
                        paramLabel,
                      })}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup>
                {visible.map((opt) => {
                  const path = fillPathTemplate(template, opt.values);
                  return (
                    <CommandItem
                      key={path}
                      value={path}
                      className="py-2"
                      onSelect={() => {
                        onPick(opt.values);
                        close();
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {opt.label}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {path}
                        </span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
