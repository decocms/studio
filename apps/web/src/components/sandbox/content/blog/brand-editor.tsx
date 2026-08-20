import { useState } from "react";
import { Stars02 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { MarkdownEditor } from "@/components/markdown-editor";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { extractPages } from "@/components/sections-editor/page-list";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import {
  type BrandRule,
  normalizeBrandRules,
  selectBrandEvidenceBlocks,
} from "./blog-data";
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
/** Fields holding `{ name, value }` rules. */
const RULE_FIELDS = ["values", "dos", "avoid", "competitors"] as const;

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
  /** Bumped to remount the markdown editors: they read `defaultValue` once. */
  const [editorRevision, setEditorRevision] = useState(0);

  /** The site's own content, ranked by how much it reveals about the voice. */
  const evidence = selectBrandEvidenceBlocks(
    decofile,
    extractPages(decofile).map((page) => page.key),
  );

  /** Fill from the site's own blocks, writing only into fields still empty. */
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
      for (const field of RULE_FIELDS) {
        if (
          normalizeBrandRules(next[field]).length === 0 &&
          result[field]?.length
        ) {
          next[field] = result[field];
          filled.push(field);
        }
      }
      if (strList(next.categories).length === 0 && result.categories?.length) {
        next.categories = result.categories;
        filled.push("categories");
      }

      setBrand(next);
      setEditorRevision((n) => n + 1);
      toast.success(
        filled.length > 0
          ? t("sandbox.blogBrand.extractFilled", {
              count: String(filled.length),
            })
          : t("sandbox.blogBrand.extractNothingEmpty"),
      );
      if (result.searchedCompetitors && result.competitors.length === 0) {
        toast.info(t("sandbox.blogBrand.noCompetitorsFound"));
      }
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

  const ruleListFor = (
    field: (typeof RULE_FIELDS)[number],
    labels: { add: string; namePlaceholder: string; bodyPlaceholder: string },
  ) => (
    <RuleList
      rules={normalizeBrandRules(brand[field])}
      onChange={(rules) => setField(field, rules)}
      revision={editorRevision}
      idPrefix={field}
      {...labels}
    />
  );

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

          {/* Outside the tabs on purpose: it fills fields across all four. */}
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

          <Tabs defaultValue="basics">
            <TabsList>
              <TabsTrigger value="basics">
                {t("sandbox.blogBrand.tabBasics")}
              </TabsTrigger>
              <TabsTrigger value="dos">
                {t("sandbox.blogBrand.tabDos")}
              </TabsTrigger>
              <TabsTrigger value="guardrails">
                {t("sandbox.blogBrand.tabGuardrails")}
              </TabsTrigger>
              <TabsTrigger value="extra">
                {t("sandbox.blogBrand.tabExtra")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="basics" className="space-y-6 pt-6">
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
            </TabsContent>

            <TabsContent value="dos" className="space-y-2 pt-6">
              <p className="text-sm text-muted-foreground">
                {t("sandbox.blogBrand.dosHint")}
              </p>
              {ruleListFor("dos", {
                add: t("sandbox.blogBrand.addDo"),
                namePlaceholder: t("sandbox.blogBrand.dosNamePlaceholder"),
                bodyPlaceholder: t("sandbox.blogBrand.dosBodyPlaceholder"),
              })}
            </TabsContent>

            <TabsContent value="guardrails" className="space-y-2 pt-6">
              <p className="text-sm text-muted-foreground">
                {t("sandbox.blogBrand.dontsHint")}
              </p>
              {ruleListFor("avoid", {
                add: t("sandbox.blogBrand.addDont"),
                namePlaceholder: t("sandbox.blogBrand.dontsNamePlaceholder"),
                bodyPlaceholder: t("sandbox.blogBrand.dontsBodyPlaceholder"),
              })}
            </TabsContent>

            <TabsContent value="extra" className="space-y-8 pt-6">
              <section className="space-y-2">
                <Label>{t("sandbox.blogBrand.valuesLabel")}</Label>
                {ruleListFor("values", {
                  add: t("sandbox.blogBrand.addValue"),
                  namePlaceholder: t("sandbox.blogBrand.valuesNamePlaceholder"),
                  bodyPlaceholder: t("sandbox.blogBrand.valuesBodyPlaceholder"),
                })}
              </section>

              <section className="space-y-2">
                <Label>{t("sandbox.blogBrand.categoriesLabel")}</Label>
                <StringList
                  addLabel={t("sandbox.blogBrand.addCategory")}
                  values={strList(brand.categories)}
                  onChange={(v) => setField("categories", v)}
                />
              </section>

              <section className="space-y-2">
                <Label>{t("sandbox.blogBrand.competitorsLabel")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.blogBrand.competitorsHint")}
                </p>
                {ruleListFor("competitors", {
                  add: t("sandbox.blogBrand.addCompetitor"),
                  namePlaceholder: t(
                    "sandbox.blogBrand.competitorsNamePlaceholder",
                  ),
                  bodyPlaceholder: t(
                    "sandbox.blogBrand.competitorsBodyPlaceholder",
                  ),
                })}
              </section>
            </TabsContent>
          </Tabs>
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
 * Editable `{ name, value }` rules — a one-line name and a markdown body. Rows
 * key by index (no stable id, no reordering); `revision` keys the editors so an
 * outside fill remounts them.
 */
function RuleList({
  rules,
  onChange,
  revision,
  idPrefix,
  add,
  namePlaceholder,
  bodyPlaceholder,
}: {
  rules: BrandRule[];
  onChange: (rules: BrandRule[]) => void;
  revision: number;
  idPrefix: string;
  add: string;
  namePlaceholder: string;
  bodyPlaceholder: string;
}) {
  const t = useT();
  const replaceAt = (index: number, patch: Partial<BrandRule>) =>
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-3">
      {rules.map((rule, index) => (
        <div
          key={index}
          className="group/item space-y-2 rounded-lg border bg-card p-3"
        >
          <div className="flex items-center gap-1.5">
            <Input
              value={rule.name}
              placeholder={namePlaceholder}
              onChange={(e) => replaceAt(index, { name: e.target.value })}
              className="h-9 font-medium"
            />
            <RemoveButton
              label={t("sandbox.blogBrand.removeItem")}
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
            />
          </div>
          <MarkdownEditor
            key={`${idPrefix}-${index}-${revision}`}
            defaultValue={rule.value}
            placeholder={bodyPlaceholder}
            onChange={(markdown) => replaceAt(index, { value: markdown })}
          />
        </div>
      ))}
      <AddButton
        label={add}
        onClick={() => onChange([...rules, { name: "", value: "" }])}
      />
    </div>
  );
}

/** Editable list of plain names — used for the blog category taxonomy. */
function StringList({
  addLabel,
  values,
  onChange,
}: {
  addLabel: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
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
