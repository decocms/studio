import { useState } from "react";
import { File02, Loading01, X } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@decocms/ui/components/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useT } from "@/i18n/use-t.ts";
import { type CategoryRef, type PostMeta } from "./blog-data";

/**
 * Right-pane panel for the bulk "Update category" action, shown while the
 * posts list is in selection mode (replaces the old modal). Pick a category,
 * then choose whether to add it (keeping existing categories) or replace all
 * categories with it (a one-step migration). Holds its own selection/mode
 * state so the parent only deals with the final apply.
 */
export function BulkCategoryPanel({
  posts,
  categories,
  initialSlug,
  isPending,
  onApply,
  onClose,
}: {
  posts: PostMeta[];
  categories: CategoryRef[];
  /** Pre-selected category (set when arriving from the category editor). */
  initialSlug?: string | null;
  isPending: boolean;
  onApply: (mode: "add" | "replace", category: CategoryRef) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [slug, setSlug] = useState<string>(
    initialSlug && categories.some((c) => c.slug === initialSlug)
      ? initialSlug
      : (categories[0]?.slug ?? ""),
  );
  const [mode, setMode] = useState<"add" | "replace">("add");
  const selected = categories.find((c) => c.slug === slug);
  const count = posts.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="truncate text-sm font-medium">
          {t("sandbox.bulkCategoryPanel.selectedCount", {
            count: String(count),
          })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={isPending}
              onClick={onClose}
              aria-label={t("sandbox.bulkCategoryPanel.exitSelection")}
            >
              <X size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("sandbox.bulkCategoryPanel.exitSelection")}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 py-8">
          <h2 className="text-2xl font-bold text-foreground">
            {t("sandbox.bulkCategoryPanel.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {count === 0
              ? t("sandbox.bulkCategoryPanel.descriptionEmpty")
              : t("sandbox.bulkCategoryPanel.descriptionWithCount", {
                  count: String(count),
                })}
          </p>

          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label>{t("sandbox.bulkCategoryPanel.categoryLabel")}</Label>
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("sandbox.bulkCategoryPanel.noCategoriesMessage")}
                </p>
              ) : (
                <Select value={slug} onValueChange={setSlug}>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={t(
                        "sandbox.bulkCategoryPanel.selectCategoryPlaceholder",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        <span className="truncate">{c.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as "add" | "replace")}
              className="gap-2"
            >
              <Label
                htmlFor="cat-mode-add"
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3"
              >
                <RadioGroupItem
                  value="add"
                  id="cat-mode-add"
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {t("sandbox.bulkCategoryPanel.modeAddTitle")}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("sandbox.bulkCategoryPanel.modeAddDescription")}
                  </span>
                </span>
              </Label>
              <Label
                htmlFor="cat-mode-replace"
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3"
              >
                <RadioGroupItem
                  value="replace"
                  id="cat-mode-replace"
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {t("sandbox.bulkCategoryPanel.modeReplaceTitle")}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("sandbox.bulkCategoryPanel.modeReplaceDescription")}
                  </span>
                </span>
              </Label>
            </RadioGroup>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isPending}
              >
                {t("sandbox.bulkCategoryPanel.cancelButton")}
              </Button>
              <Button
                type="button"
                disabled={!selected || isPending || count === 0}
                onClick={() =>
                  selected &&
                  onApply(mode, { name: selected.name, slug: selected.slug })
                }
              >
                {isPending ? (
                  <>
                    <Loading01 size={14} className="animate-spin" />
                    {t("sandbox.bulkCategoryPanel.updatingButton")}
                  </>
                ) : (
                  t("sandbox.bulkCategoryPanel.applyButton")
                )}
              </Button>
            </div>
          </div>

          {/* Selected posts, so the action's scope is visible at a glance */}
          <div className="mt-8 overflow-hidden rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2 px-4 py-3">
              <File02 size={16} className="shrink-0 text-muted-foreground" />
              <span className="text-sm">
                {t("sandbox.bulkCategoryPanel.selectedPostsLabel", {
                  count: String(count),
                })}
              </span>
            </div>
            {count === 0 ? (
              <p className="border-t bg-background px-4 py-3 text-sm text-muted-foreground">
                {t("sandbox.bulkCategoryPanel.noPostsSelectedMessage")}
              </p>
            ) : (
              <ul className="divide-y border-t bg-background">
                {posts.map((p) => (
                  <li
                    key={p.key}
                    className="flex items-center gap-2.5 px-4 py-2.5"
                  >
                    <File02
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{p.title}</span>
                      {p.slug && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {p.slug}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
