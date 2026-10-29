/**
 * The org's brand at a glance: its voice, its look and the sections of its
 * bible. Read from the brand folders agents write (`home/brands/<name>/`)
 * and edited in place, section by section.
 */

import type { ComponentType } from "react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  BookOpen01,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Columns03,
  Heart,
  Lock01,
  Announcement02,
  MessageChatSquare,
  MessageTextSquare01,
  SearchMd,
  Shield01,
  Target04,
  Translate01,
  Upload01,
  Users01,
  XClose,
} from "@untitledui/icons";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { useBrandLiveSync } from "@/hooks/use-brand-events";
import { useAskInChat } from "@/hooks/use-ask-in-chat";
import {
  fetchOrgFsStat,
  fetchOrgFsText,
  invalidateOrgFsWrite,
  type OrgFsEntry,
  useFileText,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsMutations,
  writeOrgFsTextIf,
} from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import {
  expandHex,
  findBrandLogo,
  isColorValue,
  parseBrandTokens,
  updateBrandToken,
} from "@/layouts/library/brand";
import { KEYS } from "@/lib/query-keys";
import { basename } from "@/layouts/library/location";
import { parseSkillMd } from "@/layouts/library/skill";
import { useProjectContext } from "@/sdk";
import {
  BRANDS_DIR,
  type BrandGroupId,
  type BrandItemId,
  brandDoDont,
  brandQuote,
  brandSections,
  fontName,
  formatsFrom,
  groupBrandSections,
  pickBrandDir,
  sectionMarkdown,
  withFontName,
  writeFrontmatter,
  writeQuote,
  writeSection,
} from "@decocms/shared/brand";
import { parseFrontmatterDoc } from "@decocms/shared/harness/skill-md";
import { useBlogAi } from "@/hooks/use-blog-ai";
import { scanCampaigns } from "@/components/sandbox/content/blog/blog-data";
import { useBlogState } from "@/components/sandbox/content/blog/use-blog-state";

/** The colors a brand is recognised by, in the order a person names them. */
const SWATCHES = ["primary", "secondary", "accent", "bg", "fg"] as const;

const SWATCH_LABELS = {
  primary: "library.context.colorPrimary",
  secondary: "library.context.colorSecondary",
  accent: "library.context.colorAccent",
  bg: "library.context.colorBackground",
  fg: "library.context.colorText",
} as const satisfies Record<(typeof SWATCHES)[number], TranslationKey>;

type Icon = ComponentType<{ size?: number; className?: string }>;

const GROUP_LABELS = {
  basics: "library.context.groupBasics",
  rules: "library.context.groupRules",
  guardrails: "library.context.groupGuardrails",
  extra: "library.context.groupExtra",
  content: "library.context.groupContent",
} as const satisfies Record<BrandGroupId, TranslationKey>;

const ITEMS = {
  voice: { labelKey: "library.context.itemVoice", Icon: MessageChatSquare },
  audience: { labelKey: "library.context.itemAudience", Icon: Users01 },
  examples: {
    labelKey: "library.context.itemExamples",
    Icon: MessageTextSquare01,
  },
  rules: { labelKey: "library.context.itemRules", Icon: CheckCircle },
  vocabulary: { labelKey: "library.context.itemVocabulary", Icon: Translate01 },
  donts: { labelKey: "library.context.itemDonts", Icon: Shield01 },
  values: { labelKey: "library.context.itemValues", Icon: Heart },
  competitors: { labelKey: "library.context.itemCompetitors", Icon: Target04 },
  keywords: { labelKey: "library.context.itemKeywords", Icon: SearchMd },
  dates: { labelKey: "library.context.itemDates", Icon: Calendar },
  policies: { labelKey: "library.context.itemPolicies", Icon: Lock01 },
  formats: { labelKey: "library.context.itemFormats", Icon: Columns03 },
} as const satisfies Record<
  BrandItemId,
  { labelKey: TranslationKey; Icon: Icon }
>;

/** How a fill treats what is already written; "only empty" never touches it. */
const FILL_MODES = [
  {
    promptKey: "library.context.fillBrandPrompt",
    labelKey: "library.context.fillModeEmpty",
  },
  {
    promptKey: "library.context.fillBrandReplacePrompt",
    labelKey: "library.context.fillModeReplace",
  },
] as const satisfies readonly {
  promptKey: TranslationKey;
  labelKey: TranslationKey;
}[];

/** The frontmatter keys the blog reads that the page edits. */
const META_KEYS = ["site", "language"] as const;

const META_LABELS = {
  site: "library.context.siteLabel",
  language: "library.context.languageLabel",
} as const satisfies Record<(typeof META_KEYS)[number], TranslationKey>;

const META_PLACEHOLDERS = {
  site: "library.context.sitePlaceholder",
  language: "library.context.languagePlaceholder",
} as const satisfies Record<(typeof META_KEYS)[number], TranslationKey>;

/** The brand's campaigns, as one row that opens them. */
function CampaignsRow() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const blog = useBlogState({ orgSlug: org.slug });
  const live = scanCampaigns(blog.blocks).filter(
    (campaign) => campaign.status !== "finished",
  );
  return (
    <SectionRow
      title={t("library.context.itemCampaigns")}
      summary={
        live.map((campaign) => campaign.name).join(", ") ||
        t("library.context.noCampaigns")
      }
      Icon={Announcement02}
      onOpen={() =>
        void navigate({ to: ".", search: { section: "campaigns" } })
      }
    />
  );
}

/** A formats section's summary: the names of the formats it defines. */
function formatNames(md: string, title: string): string {
  return formatsFrom(sectionMarkdown(md, title) ?? "")
    .map((format) => format.name)
    .join(", ");
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function BrandOverview() {
  const t = useT();
  const { org } = useProjectContext();
  useBrandLiveSync();
  const ask = useAskInChat();
  const listing = useOrgFsList(HOME_MOUNT_PATH, BRANDS_DIR);
  const brands = (listing.data ?? []).filter((entry) => entry.kind === "dir");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const defaultDir = pickBrandDir(
    org.slug,
    brands.map((brand) => basename(brand.path)),
  );
  const selected =
    brands.find((brand) => brand.path === selectedPath) ??
    brands.find((brand) => basename(brand.path) === defaultDir) ??
    null;

  if (listing.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (!selected) {
    return (
      <EmptyState
        image={null}
        title={t("library.context.brandEmptyTitle")}
        description={t("library.context.brandEmptyDescription")}
        actions={
          <Button
            size="sm"
            onClick={() =>
              ask(
                t("library.context.fillBrandPrompt", {
                  path: `${HOME_MOUNT_PATH}/${BRANDS_DIR}/${org.slug}/brand.md`,
                  site: t("library.context.siteUnknown"),
                }),
              )
            }
          >
            {t("library.context.fillFromSite")}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {brands.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {brands.map((brand) => (
            <Button
              key={brand.path}
              variant="outline"
              size="sm"
              onClick={() => setSelectedPath(brand.path)}
              aria-pressed={brand.path === selected.path}
            >
              {basename(brand.path)}
            </Button>
          ))}
        </div>
      )}
      <BrandDetail key={selected.path} brand={selected} />
    </div>
  );
}

function BrandDetail({ brand }: { brand: OrgFsEntry }) {
  const t = useT();
  const blogAi = useBlogAi();
  const fileUrl = useOrgFsFileUrl();
  const queryClient = useQueryClient();
  const ask = useAskInChat();
  const { org } = useProjectContext();
  const { upload, remove } = useOrgFsMutations(HOME_MOUNT_PATH);
  const logoInput = useRef<HTMLInputElement>(null);
  /** Null while reading; while editing, what changed, by section title or token id. */
  const [draft, setDraft] = useState<{
    sections: Record<string, string>;
    tokens: Record<string, string>;
    quote: string | null;
    /** Frontmatter keys the blog reads, by key. */
    meta: Record<string, string>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;
  const listing = useOrgFsList(HOME_MOUNT_PATH, brand.path);
  const files = listing.data ?? [];
  const has = (name: string) =>
    files.some((f) => f.kind === "file" && basename(f.path) === name);
  const tokensUrl = fileUrl(HOME_MOUNT_PATH, `${brand.path}/tokens.css`);
  const mdUrl = fileUrl(HOME_MOUNT_PATH, `${brand.path}/brand.md`);
  const tokensCss = useFileText(tokensUrl, { enabled: has("tokens.css") });
  const brandMd = useFileText(mdUrl, { enabled: has("brand.md") });

  /* Saving rebuilds whole files, so editing waits until both have been read. */
  const loaded =
    listing.isSuccess &&
    (!has("brand.md") || typeof brandMd.data === "string") &&
    (!has("tokens.css") || typeof tokensCss.data === "string");
  const raw = brandMd.data ?? "";
  const md = parseSkillMd(raw);
  const frontmatter = parseFrontmatterDoc(raw).fm;
  /** A frontmatter key as the page shows it: the draft while editing, else the file's. */
  const metaValue = (key: (typeof META_KEYS)[number]) =>
    draft?.meta[key] ?? frontmatter[key] ?? "";
  const siteForPrompt = frontmatter.site || t("library.context.siteUnknown");
  const setMeta = (key: string, value: string) =>
    setDraft((d) => d && { ...d, meta: { ...d.meta, [key]: value } });
  const name = md.name ?? titleCase(basename(brand.path));
  /** The brand's own line: its quote, else the description it gave itself — never a section's text. */
  const quote = brandQuote(md.body) ?? (frontmatter.description || null);
  const { doLine, dontLine } = brandDoDont(md.body);
  const { groups, more } = groupBrandSections(brandSections(md.body));
  const guidePath = `${HOME_MOUNT_PATH}/${brand.path}/brand.md`;
  const logo = findBrandLogo(files);

  const tokens = parseBrandTokens(tokensCss.data ?? "");
  const token = (id: string) =>
    tokens.find((tk) => tk.name === `--brand-${id}`)?.value;
  const swatches = SWATCHES.flatMap((id) => {
    const value = token(id);
    return value ? [{ id, value }] : [];
  });
  /** A token as the page shows it: the draft while editing, else the file's. */
  const shown = (id: string) => draft?.tokens[id] ?? token(id);
  const setToken = (id: string, value: string) =>
    setDraft((d) => d && { ...d, tokens: { ...d.tokens, [id]: value } });
  const display = shown("font-display");
  const body = shown("font-body");
  const toneBackground =
    token("primary-900") ?? token("primary-800") ?? token("primary");

  const sectionText = (title: string) =>
    draft?.sections[title] ?? sectionMarkdown(raw, title) ?? "";
  const setSection = (title: string, text: string) =>
    setDraft((d) => d && { ...d, sections: { ...d.sections, [title]: text } });

  const save = async () => {
    if (!draft) return;
    let nextMd = raw;
    for (const [title, text] of Object.entries(draft.sections)) {
      const before = sectionMarkdown(raw, title);
      if (text.trim() === (before ?? "").trim()) continue;
      if (before === null && !text.trim()) continue;
      nextMd = writeSection(nextMd, title, text);
    }
    for (const [key, value] of Object.entries(draft.meta)) {
      if (value.trim() !== (frontmatter[key] ?? "").trim()) {
        nextMd = writeFrontmatter(nextMd, key, value);
      }
    }
    if (draft.quote !== null && draft.quote.trim() !== (quote ?? "").trim()) {
      nextMd = writeQuote(nextMd, draft.quote);
    }
    const invalid = Object.entries(draft.tokens).some(
      ([id, value]) =>
        (SWATCHES as readonly string[]).includes(id) && !isColorValue(value),
    );
    if (invalid) {
      toast.error(t("library.brandPreview.invalidColor"));
      return;
    }
    const baseCss = tokensCss.data ?? "";
    let nextCss = baseCss;
    for (const [id, value] of Object.entries(draft.tokens)) {
      if (value !== token(id)) {
        nextCss = updateBrandToken(nextCss, `--brand-${id}`, value);
      }
    }
    const writes: {
      file: string;
      base: string;
      next: string;
      type: string;
      url: string;
    }[] = [];
    if (nextMd !== raw) {
      writes.push({
        file: "brand.md",
        base: raw,
        next: nextMd,
        type: "text/markdown; charset=utf-8",
        url: mdUrl,
      });
    }
    if (nextCss !== baseCss) {
      writes.push({
        file: "tokens.css",
        base: baseCss,
        next: nextCss,
        type: "text/css; charset=utf-8",
        url: tokensUrl,
      });
    }
    setSaving(true);
    try {
      for (const write of writes) {
        const path = `${brand.path}/${write.file}`;
        const outcome = await writeIfUnchanged(org.slug, path, write);
        await queryClient.invalidateQueries({
          queryKey: KEYS.fileText(write.url),
        });
        invalidateOrgFsWrite(queryClient, org.id, HOME_MOUNT_PATH);
        /* The blog reads this guide as its brand. */
        void queryClient.invalidateQueries({
          queryKey: KEYS.blogState(org.slug),
        });
        if (outcome !== "saved") {
          toast.error(
            t(
              outcome === "conflict"
                ? "library.brandPreview.brandChanged"
                : "library.brandPreview.failedSaveBrand",
            ),
          );
          return;
        }
      }
      if (writes.length > 0)
        toast.success(t("library.brandPreview.brandSaved"));
      setDraft(null);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("library.brandPreview.failedSaveBrand"),
      );
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (picked: FileList | null) => {
    const file = picked?.[0];
    if (!file) return;
    const target = `logo.${(file.name.split(".").pop() ?? "png").toLowerCase()}`;
    try {
      await upload.mutateAsync({
        dir: brand.path,
        files: [new File([file], target, { type: file.type })],
      });
      if (logo && basename(logo) !== target) await remove.mutateAsync(logo);
      toast.success(t("library.brandPreview.logoUpdated"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("library.brandPreview.logoUploadFailed"),
      );
    } finally {
      if (logoInput.current) logoInput.current.value = "";
    }
  };

  const row = (title: string, label: string, Icon: Icon, summary?: string) =>
    editing ? (
      <SectionField
        key={title}
        label={label}
        Icon={Icon}
        value={sectionText(title)}
        onChange={(text) => setSection(title, text)}
      />
    ) : summary !== undefined ? (
      <SectionRow
        key={title}
        title={label}
        summary={summary}
        Icon={Icon}
        onOpen={startEditing}
      />
    ) : (
      <div
        key={title}
        className="flex h-14 items-center gap-3 border-b border-border/70 px-1"
      >
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <span className="w-44 shrink-0 truncate text-sm text-muted-foreground">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {t("library.context.notWritten")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            ask(
              t("library.context.fillSectionPrompt", {
                section: label,
                path: guidePath,
                site: siteForPrompt,
              }),
            )
          }
        >
          {t("library.context.fill")}
        </Button>
      </div>
    );

  function startEditing() {
    if (!loaded) return;
    setDraft({ sections: {}, tokens: {}, quote: null, meta: {} });
  }

  return (
    <>
      <Page.Actions>
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              {t("library.brandPreview.cancel")}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {t("library.brandPreview.save")}
            </Button>
          </>
        ) : (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">
                  {t("library.context.fillFromSite")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {FILL_MODES.map(({ promptKey, labelKey }) => (
                  <DropdownMenuItem
                    key={promptKey}
                    onSelect={() =>
                      ask(
                        t(promptKey, { path: guidePath, site: siteForPrompt }),
                      )
                    }
                  >
                    {t(labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" disabled={!loaded} onClick={startEditing}>
              {t("library.context.editBrand")}
            </Button>
          </>
        )}
      </Page.Actions>

      <div className="flex items-center gap-3">
        <input
          ref={logoInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void uploadLogo(e.target.files)}
        />
        {(logo || editing) && (
          <button
            type="button"
            disabled={!editing}
            onClick={() => logoInput.current?.click()}
            aria-label={t(
              logo
                ? "library.brandPreview.replaceLogo"
                : "library.brandPreview.addLogo",
            )}
            className="group relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60 text-muted-foreground enabled:cursor-pointer"
          >
            {logo ? (
              <img
                src={fileUrl(HOME_MOUNT_PATH, logo)}
                alt=""
                className="size-full object-contain"
              />
            ) : (
              <Upload01 size={16} />
            )}
            {logo && editing && (
              <span className="absolute inset-0 flex items-center justify-center bg-foreground/50 text-background opacity-0 transition-opacity group-hover:opacity-100">
                <Upload01 size={14} />
              </span>
            )}
          </button>
        )}
        <div className="flex min-w-0 flex-col">
          <h1 className="min-w-0 text-2xl font-medium text-foreground">
            {name}
          </h1>
          {!editing && (metaValue("site") || metaValue("language")) && (
            <span className="truncate text-xs text-muted-foreground">
              {[metaValue("site"), metaValue("language")]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      </div>
      {editing && (
        <div className="grid gap-3 sm:grid-cols-2">
          {META_KEYS.map((key) => (
            <label
              key={key}
              className="flex flex-col gap-1.5 text-xs text-muted-foreground"
            >
              {t(META_LABELS[key])}
              <Input
                value={metaValue(key)}
                placeholder={t(META_PLACEHOLDERS[key])}
                onChange={(e) => setMeta(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <section
          className="flex min-h-72 flex-col justify-between gap-8 rounded-2xl bg-foreground p-7 text-background"
          style={toneBackground ? { background: toneBackground } : undefined}
        >
          <div className="flex flex-col gap-4">
            <span className="text-xs opacity-70">
              {t("library.context.toneOfVoice")}
            </span>
            {editing ? (
              <textarea
                aria-label={t("library.context.toneOfVoice")}
                value={draft.quote ?? quote ?? ""}
                onChange={(e) =>
                  setDraft((d) => d && { ...d, quote: e.target.value })
                }
                className="field-sizing-content min-h-24 w-full resize-none rounded-xl bg-background/10 p-3 text-2xl leading-snug font-medium text-background outline-none focus:bg-background/15"
              />
            ) : quote ? (
              <p className="text-2xl leading-snug font-medium text-pretty">
                “{quote}”
              </p>
            ) : (
              <p className="text-sm opacity-70">
                {t("library.brandPreview.noVoiceYet")}
              </p>
            )}
          </div>
          {(doLine || dontLine) && (
            <div className="grid gap-6 sm:grid-cols-2">
              {doLine && (
                <VoiceExample
                  label={t("library.context.soundsLike")}
                  Icon={Check}
                  text={doLine}
                />
              )}
              {dontLine && (
                <VoiceExample
                  label={t("library.context.doesNotSoundLike")}
                  Icon={XClose}
                  text={dontLine}
                />
              )}
            </div>
          )}
        </section>

        <section className="flex min-h-72 flex-col justify-between gap-8 rounded-2xl bg-muted/50 p-6">
          <div className="flex flex-col gap-4">
            <span className="text-xs text-muted-foreground">
              {t("library.context.look")}
            </span>
            {swatches.length > 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {swatches.slice(0, 4).map((swatch) => (
                  <Swatch
                    key={swatch.id}
                    label={t(SWATCH_LABELS[swatch.id])}
                    value={shown(swatch.id) ?? swatch.value}
                    editable={editing}
                    onChange={(value) => setToken(swatch.id, value)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("library.context.noTokens")}
              </p>
            )}
          </div>
          {(display || body) && (
            <div className="flex items-center gap-4">
              <span
                className="text-4xl text-foreground"
                style={display ? { fontFamily: display } : undefined}
              >
                Aa
              </span>
              {editing ? (
                <div className="grid min-w-0 flex-1 gap-2">
                  {(
                    [
                      ["font-display", display, "library.context.fontTitles"],
                      ["font-body", body, "library.context.fontText"],
                    ] as const
                  ).map(
                    ([id, value, labelKey]) =>
                      value && (
                        <label
                          key={id}
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <span className="w-12 shrink-0">{t(labelKey)}</span>
                          <Input
                            value={fontName(value)}
                            onChange={(e) =>
                              setToken(id, withFontName(value, e.target.value))
                            }
                          />
                        </label>
                      ),
                  )}
                </div>
              ) : (
                <div className="flex min-w-0 flex-col">
                  {display && (
                    <span className="truncate text-sm font-medium text-foreground">
                      {t("library.context.fontForTitles", {
                        font: fontName(display),
                      })}
                    </span>
                  )}
                  {body && (
                    <span className="truncate text-xs text-muted-foreground">
                      {t("library.context.fontForText", {
                        font: fontName(body),
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {groups.map((group) => (
        <section key={group.id} className="flex flex-col">
          <h2 className="pb-1 text-xs text-muted-foreground">
            {t(GROUP_LABELS[group.id])}
          </h2>
          {group.items.map((item) => {
            const { labelKey, Icon: ItemIcon } = ITEMS[item.id];
            if (item.sections.length === 0) {
              return row(t(labelKey), t(labelKey), ItemIcon);
            }
            return item.sections.map((section) =>
              row(
                section.title,
                section.title,
                ItemIcon,
                item.id === "formats"
                  ? formatNames(raw, section.title) || section.summary
                  : section.summary,
              ),
            );
          })}
          {group.id === "content" && blogAi && <CampaignsRow />}
        </section>
      ))}
      {more.length > 0 && (
        <section className="flex flex-col">
          <h2 className="pb-1 text-xs text-muted-foreground">
            {t("library.context.groupMore")}
          </h2>
          {more.map((section) =>
            row(section.title, section.title, BookOpen01, section.summary),
          )}
        </section>
      )}
    </>
  );
}

/** A color; while editing, a picker over it. Only hex values can be picked. */
function Swatch({
  label,
  value,
  editable,
  onChange,
}: {
  label: string;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const face = (
    <span
      className="h-14 rounded-xl border border-border/60"
      style={{ background: value }}
    />
  );
  const pickable = isColorValue(value) && value.startsWith("#");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {editable && pickable ? (
        <label className="relative flex cursor-pointer flex-col rounded-xl ring-2 ring-ring/30 transition-shadow hover:ring-ring/60">
          {face}
          <input
            type="color"
            aria-label={label}
            value={expandHex(value)}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      ) : (
        face
      )}
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      {editable && (
        <input
          aria-label={label}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="-mt-1 w-full rounded-md bg-transparent font-mono text-xs text-foreground focus:bg-background focus-ring"
        />
      )}
    </div>
  );
}

/** A section's text while the page is being edited. */
function SectionField({
  label,
  Icon: SectionIcon,
  value,
  onChange,
}: {
  label: string;
  Icon: Icon;
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2 border-b border-border/70 px-1 py-4">
      <span className="flex items-center gap-3 text-sm font-medium text-foreground">
        <SectionIcon size={16} className="shrink-0 text-muted-foreground" />
        {label}
      </span>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field-sizing-content min-h-20"
      />
    </label>
  );
}

function SectionRow({
  title,
  summary,
  Icon: SectionIcon,
  onOpen,
}: {
  title: string;
  summary: string;
  Icon: Icon;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-14 items-center gap-3 border-b border-border/70 px-1 text-left"
    >
      <SectionIcon size={16} className="shrink-0 text-muted-foreground" />
      <span className="w-44 shrink-0 truncate text-sm font-medium text-foreground">
        {title}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {summary}
      </span>
      <ChevronRight
        size={16}
        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}

function VoiceExample({
  label,
  Icon,
  text,
}: {
  label: string;
  Icon: Icon;
  text: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs opacity-70">{label}</span>
      <span className="flex items-start gap-2 text-sm">
        <span className="inline-flex h-[1lh] shrink-0 items-center">
          <Icon size={14} />
        </span>
        {text}
      </span>
    </div>
  );
}

/**
 * Writes `next` only over the text the edit started from, so a save never
 * replaces what an agent or teammate wrote meanwhile.
 */
async function writeIfUnchanged(
  orgSlug: string,
  path: string,
  write: { base: string; next: string; type: string },
): Promise<"saved" | "conflict" | "forbidden"> {
  const stat = await fetchOrgFsStat(orgSlug, HOME_MOUNT_PATH, path);
  const current = stat
    ? await fetchOrgFsText(orgSlug, HOME_MOUNT_PATH, path)
    : "";
  if (current !== write.base) return "conflict";
  const expect = !stat
    ? { absent: true as const }
    : stat.contentHash
      ? { contentHash: stat.contentHash }
      : null;
  const result = await writeOrgFsTextIf(
    orgSlug,
    HOME_MOUNT_PATH,
    path,
    write.next,
    expect,
    write.type,
  );
  return result.ok ? "saved" : result.reason;
}
