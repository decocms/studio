/**
 * The org's brand at a glance: its voice, its look and the sections of its
 * bible. Read from the brand folders agents write (`home/brands/<name>/`);
 * editing opens the Library's brand editor.
 */

import type { ComponentType } from "react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BookOpen01,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Heart,
  Lock01,
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
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { useAskInChat } from "@/hooks/use-ask-in-chat";
import {
  type OrgFsEntry,
  useFileText,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsMutations,
  useOrgFsWriteText,
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
  type BrandGroupId,
  type BrandItemId,
  brandDoDont,
  brandQuote,
  brandSections,
  fontName,
  groupBrandSections,
  sectionMarkdown,
  withFontName,
  writeQuote,
  writeSection,
} from "./brand-md";

const BRANDS_DIR = "brands";

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
} as const satisfies Record<
  BrandItemId,
  { labelKey: TranslationKey; Icon: Icon }
>;

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function BrandOverview() {
  const t = useT();
  const { org } = useProjectContext();
  const ask = useAskInChat();
  const listing = useOrgFsList(HOME_MOUNT_PATH, BRANDS_DIR);
  const brands = (listing.data ?? []).filter((entry) => entry.kind === "dir");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected =
    brands.find((brand) => brand.path === selectedPath) ?? brands[0] ?? null;

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
            <button
              key={brand.path}
              type="button"
              onClick={() => setSelectedPath(brand.path)}
              aria-pressed={brand.path === selected.path}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                brand.path === selected.path
                  ? "border-transparent bg-muted font-medium text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {basename(brand.path)}
            </button>
          ))}
        </div>
      )}
      <BrandDetail key={selected.path} brand={selected} />
    </div>
  );
}

function BrandDetail({ brand }: { brand: OrgFsEntry }) {
  const t = useT();
  const fileUrl = useOrgFsFileUrl();
  const queryClient = useQueryClient();
  const ask = useAskInChat();
  const writeText = useOrgFsWriteText(HOME_MOUNT_PATH);
  const { upload, remove } = useOrgFsMutations(HOME_MOUNT_PATH);
  const logoInput = useRef<HTMLInputElement>(null);
  /** Null while reading; while editing, what changed, by section title or token id. */
  const [draft, setDraft] = useState<{
    sections: Record<string, string>;
    tokens: Record<string, string>;
    quote: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;
  const files = useOrgFsList(HOME_MOUNT_PATH, brand.path).data ?? [];
  const has = (name: string) =>
    files.some((f) => f.kind === "file" && basename(f.path) === name);
  const tokensUrl = fileUrl(HOME_MOUNT_PATH, `${brand.path}/tokens.css`);
  const mdUrl = fileUrl(HOME_MOUNT_PATH, `${brand.path}/brand.md`);
  const tokensCss = useFileText(tokensUrl, { enabled: has("tokens.css") });
  const brandMd = useFileText(mdUrl, { enabled: has("brand.md") });

  const raw = brandMd.data ?? "";
  const md = parseSkillMd(raw);
  const name = md.name ?? titleCase(basename(brand.path));
  const quote = brandQuote(md.body) ?? md.description;
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
    if (draft.quote !== null && draft.quote.trim() !== (quote ?? "").trim()) {
      nextMd = writeQuote(nextMd, draft.quote);
    }
    let nextCss = tokensCss.data ?? "";
    for (const [id, value] of Object.entries(draft.tokens)) {
      /* A half-typed hex is not a color yet; the file keeps the last one. */
      const color = (SWATCHES as readonly string[]).includes(id);
      if (color && !isColorValue(value)) continue;
      if (value !== token(id)) {
        nextCss = updateBrandToken(nextCss, `--brand-${id}`, value);
      }
    }
    setSaving(true);
    try {
      const writes: [string, string, string, string][] = [];
      if (nextMd !== raw) {
        writes.push([
          "brand.md",
          nextMd,
          "text/markdown; charset=utf-8",
          mdUrl,
        ]);
      }
      if (nextCss !== (tokensCss.data ?? "")) {
        writes.push([
          "tokens.css",
          nextCss,
          "text/css; charset=utf-8",
          tokensUrl,
        ]);
      }
      for (const [file, text, contentType, url] of writes) {
        await writeText.mutateAsync({
          path: `${brand.path}/${file}`,
          body: text,
          contentType,
        });
        await queryClient.invalidateQueries({ queryKey: KEYS.fileText(url) });
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
              }),
            )
          }
        >
          {t("library.context.fill")}
        </Button>
      </div>
    );

  function startEditing() {
    setDraft({ sections: {}, tokens: {}, quote: null });
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                ask(t("library.context.fillBrandPrompt", { path: guidePath }))
              }
            >
              {t("library.context.fillFromSite")}
            </Button>
            <Button size="sm" onClick={startEditing}>
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
        <h1 className="min-w-0 text-2xl font-medium text-foreground">{name}</h1>
      </div>

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
              row(section.title, section.title, ItemIcon, section.summary),
            );
          })}
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
          className="-mt-1 w-full rounded-md bg-transparent font-mono text-xs text-foreground outline-none focus:bg-background focus:ring-1 focus:ring-ring/40"
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
