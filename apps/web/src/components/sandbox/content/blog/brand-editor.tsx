import { useState } from "react";
import { Stars02 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { extractPages } from "@/components/sections-editor/page-list";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { selectBrandEvidenceBlocks } from "./blog-data";
import { AddButton, RemoveButton, str } from "./blocks/primitives";

/**
 * Editorial brand context editor — the tone of voice and generation dos/don'ts
 * that every generated blogpost is written against.
 *
 * Persists to `.deco/blocks/blog-manager-brand.json` in the site's own repo, as
 * plain JSON (no `__resolveType`): the site never renders this block, only the
 * generator reads it. Same path and field names Spire writes, so a site it
 * already set up opens here populated.
 */
export const BRAND_BLOCK_KEY = "blog-manager-brand";

/** Stable empty seed — `useAutosave` re-seeds on reference change. */
const EMPTY_BRAND: Record<string, unknown> = {};

/** Free-text fields the extractor may fill. */
const TEXT_FIELDS = ["description", "tone", "targetAudience"] as const;
/** List fields the extractor may fill. */
const LIST_FIELDS = [
  "values",
  "dos",
  "avoid",
  "categories",
  "competitors",
] as const;

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

export function BlogBrandEditor({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
}) {
  const block = decofile[BRAND_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlogBlock({
    orgSlug,
    virtualMcpId,
    branch,
    packagePath: usePackagePath(virtualMcpId),
  });

  const [brand, setBrand] = useAutosave(block ?? EMPTY_BRAND, (next) => {
    save.mutate({ blockKey: BRAND_BLOCK_KEY, data: next });
  });

  const setField = (key: string, value: unknown) =>
    setBrand({ ...brand, [key]: value });

  const [isExtracting, setIsExtracting] = useState(false);

  /** The site's own content, ranked by how much it reveals about the voice. */
  const evidence = selectBrandEvidenceBlocks(
    decofile,
    extractPages(decofile).map((page) => page.key),
  );

  /**
   * Read the site's own blocks and fill from them. Only writes into fields that
   * are currently empty — re-running must never wipe dos/don'ts someone wrote
   * by hand, which is the whole point of having them.
   */
  const extract = async () => {
    if (evidence.length === 0) return;
    setIsExtracting(true);
    try {
      const result = await studio.call("BLOG_BRAND_EXTRACT", {
        blocks: evidence,
      });
      const next: Record<string, unknown> = { ...brand };
      const filled: string[] = [];

      if (!str(next.companyName) && result.companyName) {
        next.companyName = result.companyName;
        filled.push("companyName");
      }
      if (!str(next.language) && result.language) {
        next.language = result.language;
        filled.push("language");
      }
      for (const field of TEXT_FIELDS) {
        if (!str(next[field]) && result[field]) {
          next[field] = result[field];
          filled.push(field);
        }
      }
      for (const field of LIST_FIELDS) {
        if (strList(next[field]).length === 0 && result[field]?.length) {
          next[field] = result[field];
          filled.push(field);
        }
      }

      setBrand(next);
      toast.success(
        filled.length > 0
          ? t("sandbox.blogBrand.extractFilled", {
              count: String(filled.length),
            })
          : t("sandbox.blogBrand.extractNothingEmpty"),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.blogBrand.extractFailed"),
      );
    } finally {
      setIsExtracting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="truncate text-sm font-medium">
          {t("sandbox.autonomous.title")}
        </span>
        <SaveStatus isPending={save.isPending} isError={save.isError} />
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-8 py-8">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">
              {t("sandbox.blogBrand.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("sandbox.blogBrand.subtitle")}
            </p>
          </div>

          {/* Read the brand from the site's own content */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <div className="space-y-1">
              <Label>{t("sandbox.blogBrand.extractLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {evidence.length > 0
                  ? t("sandbox.blogBrand.extractHint", {
                      count: String(evidence.length),
                    })
                  : t("sandbox.blogBrand.extractNoContent")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isExtracting || evidence.length === 0}
              onClick={() => void extract()}
            >
              <Stars02 size={14} />
              {isExtracting
                ? t("sandbox.blogBrand.extracting")
                : t("sandbox.blogBrand.extractButton")}
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="brand-company-name"
              label={t("sandbox.blogBrand.companyNameLabel")}
              value={str(brand.companyName)}
              onChange={(v) => setField("companyName", v)}
            />
            <Field
              id="brand-language"
              label={t("sandbox.blogBrand.languageLabel")}
              placeholder="pt-BR"
              value={str(brand.language)}
              onChange={(v) => setField("language", v)}
            />
          </div>

          <TextAreaField
            id="brand-description"
            label={t("sandbox.blogBrand.descriptionLabel")}
            value={str(brand.description)}
            onChange={(v) => setField("description", v)}
          />
          <TextAreaField
            id="brand-tone"
            label={t("sandbox.blogBrand.toneLabel")}
            hint={t("sandbox.blogBrand.toneHint")}
            value={str(brand.tone)}
            onChange={(v) => setField("tone", v)}
            rows={5}
          />
          <TextAreaField
            id="brand-audience"
            label={t("sandbox.blogBrand.audienceLabel")}
            value={str(brand.targetAudience)}
            onChange={(v) => setField("targetAudience", v)}
          />

          <StringList
            label={t("sandbox.blogBrand.dosLabel")}
            hint={t("sandbox.blogBrand.dosHint")}
            addLabel={t("sandbox.blogBrand.addDo")}
            values={strList(brand.dos)}
            onChange={(v) => setField("dos", v)}
          />
          <StringList
            label={t("sandbox.blogBrand.dontsLabel")}
            hint={t("sandbox.blogBrand.dontsHint")}
            addLabel={t("sandbox.blogBrand.addDont")}
            values={strList(brand.avoid)}
            onChange={(v) => setField("avoid", v)}
          />
          <StringList
            label={t("sandbox.blogBrand.valuesLabel")}
            addLabel={t("sandbox.blogBrand.addValue")}
            values={strList(brand.values)}
            onChange={(v) => setField("values", v)}
          />
          <StringList
            label={t("sandbox.blogBrand.categoriesLabel")}
            addLabel={t("sandbox.blogBrand.addCategory")}
            values={strList(brand.categories)}
            onChange={(v) => setField("categories", v)}
          />
          <StringList
            label={t("sandbox.blogBrand.competitorsLabel")}
            addLabel={t("sandbox.blogBrand.addCompetitor")}
            values={strList(brand.competitors)}
            onChange={(v) => setField("competitors", v)}
          />
        </div>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-10"
      />
    </div>
  );
}

function TextAreaField({
  id,
  label,
  hint,
  value,
  onChange,
  rows = 3,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * Editable list of free-text lines (dos, don'ts, values, categories). Rows are
 * keyed by index: they carry no stable id and reordering isn't offered, so
 * position is the identity.
 */
function StringList({
  label,
  hint,
  addLabel,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  addLabel: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="space-y-1.5">
        {values.map((value, index) => (
          <div key={index} className="group/item flex items-center gap-1.5">
            <Input
              value={value}
              onChange={(e) =>
                onChange(
                  values.map((v, i) => (i === index ? e.target.value : v)),
                )
              }
              className="h-9"
            />
            <RemoveButton
              label={t("sandbox.blogBrand.removeItem")}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </div>
      <AddButton label={addLabel} onClick={() => onChange([...values, ""])} />
    </div>
  );
}
