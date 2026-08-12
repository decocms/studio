/**
 * Brand preview — a first-class render and editor for brand folders
 * (`?brand=<browse path>`). View mode shows the logo, color swatches and font
 * tokens parsed from tokens.css, plus the brand voice from brand.md. Edit mode
 * turns those into color pickers / text fields that rewrite tokens.css in place
 * (declarations only — hand-authored CSS survives), a markdown textarea for
 * brand.md, and a logo replace upload. URL-driven, so a brand link survives
 * reload.
 *
 * One body (`BrandPreviewContent`) feeds two shells, mirroring file previews:
 * a right-side `BrandPreviewPanel` on desktop and a near-fullscreen
 * `BrandPreviewDialog` on mobile.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  ChevronDown,
  ChevronUp,
  Palette,
  Pencil01,
  Upload01,
  X,
} from "@untitledui/icons";
import { MemoizedMarkdown } from "@/components/chat/markdown.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  useFileText,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsMutations,
  useOrgFsWriteText,
} from "@/hooks/use-org-fs";
import { KEYS } from "@/lib/query-keys";
import {
  type BrandToken,
  expandHex,
  findBrandLogo,
  groupColorFamilies,
  parseBrandTokens,
  updateBrandToken,
} from "./brand";
import { BrandComponentsPreview } from "./brand-components-preview";
import { DeckThemePreview } from "./deck-theme-preview";
import { basename, parseLibraryPath } from "./location";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-medium text-foreground">{children}</p>;
}

/** A color ramp/family as a compact band of swatches (editable when hex). */
function ColorBand({
  family,
  tokens,
  editing,
  valueOf,
  onEdit,
}: {
  family: string;
  tokens: BrandToken[];
  editing: boolean;
  valueOf: (t: BrandToken) => string;
  onEdit: (name: string, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{family}</span>
      <div className="flex flex-wrap gap-1">
        {tokens.map((t) => {
          const v = valueOf(t);
          const label = `${t.name.replace(/^--brand-/, "")}: ${v}`;
          return editing && /^#/.test(v) ? (
            <input
              key={t.name}
              type="color"
              aria-label={t.name}
              title={label}
              value={expandHex(v)}
              onChange={(e) => onEdit(t.name, e.target.value)}
              className="size-7 cursor-pointer rounded-md border border-border/60 bg-transparent p-0.5"
            />
          ) : (
            <span
              key={t.name}
              title={label}
              className="size-7 rounded-md border border-border/60"
              style={{ backgroundColor: v }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Tiny visual for a non-color token (bar/box/specimen), else a spacer. */
function TokenPreview({ token, value }: { token: BrandToken; value: string }) {
  if (token.kind === "space") {
    return (
      <span className="flex h-7 w-16 shrink-0 items-center">
        <span
          className="h-1.5 rounded-full bg-primary"
          style={{ width: value, maxWidth: "100%" }}
        />
      </span>
    );
  }
  if (token.kind === "radius") {
    return (
      <span
        className="size-7 shrink-0 border border-border bg-muted/50"
        style={{ borderRadius: value }}
      />
    );
  }
  if (token.kind === "shadow") {
    return (
      <span
        className="size-7 shrink-0 rounded-md bg-background"
        style={{ boxShadow: value }}
      />
    );
  }
  if (token.kind === "type" && /^--brand-text-/.test(token.name)) {
    return (
      <span
        className="flex size-7 shrink-0 items-center justify-center overflow-hidden leading-none text-foreground"
        style={{ fontSize: `min(${value}, 22px)` }}
      >
        Ag
      </span>
    );
  }
  return <span className="size-7 shrink-0" />;
}

/** A preview + name + value/input row for a non-color token. */
function TokenRow({
  token,
  value,
  editing,
  onEdit,
}: {
  token: BrandToken;
  value: string;
  editing: boolean;
  onEdit: (name: string, value: string) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <TokenPreview token={token} value={value} />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {token.name.replace(/^--brand-/, "")}
      </span>
      {editing ? (
        <Input
          value={value}
          onChange={(e) => onEdit(token.name, e.target.value)}
          className="h-8 w-40 font-mono text-xs"
        />
      ) : (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {value}
        </span>
      )}
    </div>
  );
}

/** A labeled section of non-color token rows (Spacing, Radius, …). */
function TokenSection({
  label,
  tokens,
  editing,
  valueOf,
  onEdit,
}: {
  label: string;
  tokens: BrandToken[];
  editing: boolean;
  valueOf: (t: BrandToken) => string;
  onEdit: (name: string, value: string) => void;
}) {
  if (tokens.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex flex-col gap-2.5">
        {tokens.map((t) => (
          <TokenRow
            key={t.name}
            token={t}
            value={valueOf(t)}
            editing={editing}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}

function BrandPreviewContent({
  brandPath,
  onClose,
  variant,
}: {
  /** Browse-grammar path of the brand dir ("<volume>/<dir...>"). */
  brandPath: string;
  onClose: () => void;
  /** "dialog" uses Radix DialogTitle/DialogClose; "panel" plain elements. */
  variant: "panel" | "dialog";
}) {
  const t = useT();
  const { org } = useProjectContext();
  const location = parseLibraryPath(brandPath);
  const volume = location.volume ?? "";
  const dirPath = location.dirPath;
  const dirName = basename(dirPath);
  const readOnly = location.readOnly;

  const queryClient = useQueryClient();
  const fileUrl = useOrgFsFileUrl();
  const writeText = useOrgFsWriteText(volume);
  const { upload, remove } = useOrgFsMutations(volume);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const listing = useOrgFsList(volume, dirPath);
  const files = listing.data ?? [];
  const has = (name: string) =>
    files.some((f) => f.kind === "file" && basename(f.path) === name);
  const tokensExists = has("tokens.css");
  const mdExists = has("brand.md");
  const themeExists = has("slides-theme.html");
  const logoPath = findBrandLogo(files);

  const tokensUrl = fileUrl(volume, `${dirPath}/tokens.css`);
  const mdUrl = fileUrl(volume, `${dirPath}/brand.md`);
  const themeUrl = fileUrl(volume, `${dirPath}/slides-theme.html`);

  const tokensCss = useFileText(tokensUrl, { enabled: tokensExists });
  const brandMd = useFileText(mdUrl, { enabled: mdExists });

  const [editing, setEditing] = useState(false);
  // Token name → pending value; the displayed value is the override or original.
  const [edits, setEdits] = useState<Record<string, string>>({});
  // null = pristine (show fetched brand.md); a string is the working draft.
  const [mdDraft, setMdDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deckCollapsed, setDeckCollapsed] = useState(false);
  const [previewTab, setPreviewTab] = useState<"deck" | "components">("deck");

  const tokens = tokensCss.data ? parseBrandTokens(tokensCss.data) : [];
  const original = (name: string) => tokens.find((t) => t.name === name)?.value;
  const valueOf = (t: BrandToken) => edits[t.name] ?? t.value;
  const colorFamilies = groupColorFamilies(tokens);
  const fonts = tokens.filter((t) => t.kind === "font");
  const typeTokens = tokens.filter((t) => t.kind === "type");
  const spaceTokens = tokens.filter((t) => t.kind === "space");
  const radiusTokens = tokens.filter((t) => t.kind === "radius");
  const shadowTokens = tokens.filter((t) => t.kind === "shadow");
  const motionTokens = tokens.filter((t) => t.kind === "motion");
  const otherTokens = tokens.filter((t) => t.kind === "other");
  const onEdit = (name: string, value: string) =>
    setEdits((prev) => ({ ...prev, [name]: value }));
  // Preview tab: deck only when a theme exists, else components.
  const showDeck = themeExists && previewTab === "deck";

  const mdText = mdDraft ?? brandMd.data ?? "";
  const tokenChanges = Object.entries(edits).filter(
    ([name, v]) => original(name) !== v,
  );
  const mdChanged = mdDraft !== null && mdDraft !== (brandMd.data ?? "");
  const dirty = tokenChanges.length > 0 || mdChanged;

  function cancelEdit() {
    setEdits({});
    setMdDraft(null);
    setEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (tokenChanges.length > 0) {
        let css = tokensCss.data ?? "";
        for (const [name, v] of tokenChanges)
          css = updateBrandToken(css, name, v);
        await writeText.mutateAsync({
          path: `${dirPath}/tokens.css`,
          body: css,
          contentType: "text/css; charset=utf-8",
        });
        queryClient.invalidateQueries({ queryKey: KEYS.fileText(tokensUrl) });
      }
      if (mdChanged && mdDraft !== null) {
        await writeText.mutateAsync({
          path: `${dirPath}/brand.md`,
          body: mdDraft,
          contentType: "text/markdown; charset=utf-8",
        });
        queryClient.invalidateQueries({ queryKey: KEYS.fileText(mdUrl) });
      }
      queryClient.invalidateQueries({
        queryKey: KEYS.orgFsVolume(org.id, volume),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.orgFsRecent(org.id) });
      setEdits({});
      setMdDraft(null);
      setEditing(false);
      toast.success(t("library.brandPreview.brandSaved"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("library.brandPreview.failedSaveBrand"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoUpload(fileList: FileList | null) {
    const f = fileList?.[0];
    if (!f) return;
    const ext = (f.name.split(".").pop() ?? "png").toLowerCase();
    const targetName = `logo.${ext}`;
    try {
      await upload.mutateAsync({
        dir: dirPath,
        files: [new File([f], targetName, { type: f.type })],
      });
      // Replace a prior logo with a different extension so only one remains.
      if (logoPath && basename(logoPath) !== targetName) {
        await remove.mutateAsync(logoPath);
      }
      toast.success(t("library.brandPreview.logoUpdated"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("library.brandPreview.logoUploadFailed"),
      );
    } finally {
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  }

  const empty = !listing.isPending && !tokensExists && !mdExists && !logoPath;

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Palette size={18} />
        </div>
        {variant === "dialog" ? (
          <DialogTitle className="flex-1 truncate text-base font-medium text-foreground">
            {dirName}
          </DialogTitle>
        ) : (
          <span className="flex-1 truncate text-base font-medium text-foreground">
            {dirName}
          </span>
        )}
        {!readOnly &&
          (editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelEdit}
                disabled={saving}
              >
                {t("library.brandPreview.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={!dirty || saving}
                onClick={() => void handleSave()}
              >
                {saving
                  ? t("library.brandPreview.saving")
                  : t("library.brandPreview.save")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil01 size={14} />
              {t("library.brandPreview.edit")}
            </Button>
          ))}
        {variant === "dialog" ? (
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="size-8 shrink-0">
              <X size={16} />
            </Button>
          </DialogClose>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col">
        {listing.isPending ? (
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : empty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("library.brandPreview.brandNotAvailable")}
          </div>
        ) : (
          <>
            {/* Pinned preview — the brand applied. Toggle between the deck
                theme (16:9) and UI components; both render live from tokens.css
                and re-render on save. Collapsible to reclaim space. */}
            {(themeExists || tokensExists) && (
              <div className="shrink-0 border-b border-border">
                {/* Whole row toggles collapse; the pill group stops
                    propagation so switching tabs doesn't also collapse. */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={
                    deckCollapsed
                      ? t("library.brandPreview.showPreview")
                      : t("library.brandPreview.hidePreview")
                  }
                  onClick={() => setDeckCollapsed((c) => !c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDeckCollapsed((c) => !c);
                    }
                  }}
                  className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2.5 hover:bg-muted/40"
                >
                  <div
                    className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-xs font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {themeExists && (
                      <button
                        type="button"
                        onClick={() => {
                          setPreviewTab("deck");
                          setDeckCollapsed(false);
                        }}
                        className={cn(
                          "rounded-md px-2.5 py-1",
                          showDeck
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {t("library.brandPreview.deck")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewTab("components");
                        setDeckCollapsed(false);
                      }}
                      className={cn(
                        "rounded-md px-2.5 py-1",
                        showDeck
                          ? "text-muted-foreground hover:text-foreground"
                          : "bg-background text-foreground shadow-sm",
                      )}
                    >
                      {t("library.brandPreview.components")}
                    </button>
                  </div>
                  {deckCollapsed ? (
                    <ChevronDown
                      size={16}
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <ChevronUp
                      size={16}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                </div>
                {!deckCollapsed && (
                  <div className="px-4 pb-4">
                    <div
                      className={cn(
                        "w-full overflow-hidden rounded-xl border border-border bg-muted/30",
                        showDeck ? "aspect-[16/9]" : "h-96",
                      )}
                    >
                      {showDeck ? (
                        <DeckThemePreview
                          readUrl={themeUrl}
                          title={`${dirName} deck theme`}
                          tokensUrl={tokensUrl}
                        />
                      ) : (
                        <BrandComponentsPreview tokensUrl={tokensUrl} />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Identity, tokens and voice scroll under the pinned deck */}
            <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-6">
              {/* Logo */}
              <div className="flex flex-col gap-3">
                <SectionLabel>{t("library.brandPreview.logo")}</SectionLabel>
                <div className="flex items-center gap-4">
                  <div className="flex size-24 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30">
                    {logoPath ? (
                      <img
                        src={fileUrl(volume, logoPath)}
                        alt={`${dirName} logo`}
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <Palette size={28} className="text-muted-foreground/50" />
                    )}
                  </div>
                  {editing && (
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={upload.isPending}
                        onClick={() => logoInputRef.current?.click()}
                      >
                        <Upload01 size={14} />
                        {logoPath
                          ? t("library.brandPreview.replaceLogo")
                          : t("library.brandPreview.addLogo")}
                      </Button>
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => void handleLogoUpload(e.target.files)}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Colors — every family as a compact swatch band (hover for
                  name+value; click a hex swatch in edit mode to pick). */}
              {colorFamilies.length > 0 && (
                <div className="flex flex-col gap-3">
                  <SectionLabel>
                    {t("library.brandPreview.colors")}
                  </SectionLabel>
                  {colorFamilies.map((fam) => (
                    <ColorBand
                      key={fam.family}
                      family={fam.family}
                      tokens={fam.tokens}
                      editing={editing}
                      valueOf={valueOf}
                      onEdit={onEdit}
                    />
                  ))}
                </div>
              )}

              {/* Typography — font families + the type scale */}
              {(fonts.length > 0 || typeTokens.length > 0) && (
                <div className="flex flex-col gap-3">
                  <SectionLabel>
                    {t("library.brandPreview.typography")}
                  </SectionLabel>
                  {fonts.map((font) => (
                    <div key={font.name} className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        {font.name.replace(/^--brand-font-?/, "") ||
                          t("library.brandPreview.defaultFont")}
                      </span>
                      {editing ? (
                        <Input
                          value={valueOf(font)}
                          onChange={(e) => onEdit(font.name, e.target.value)}
                          className="h-9"
                        />
                      ) : (
                        <span
                          className="truncate text-lg text-foreground"
                          style={{ fontFamily: valueOf(font) }}
                        >
                          {valueOf(font)}
                        </span>
                      )}
                    </div>
                  ))}
                  {typeTokens.map((token) => (
                    <TokenRow
                      key={token.name}
                      token={token}
                      value={valueOf(token)}
                      editing={editing}
                      onEdit={onEdit}
                    />
                  ))}
                </div>
              )}

              <TokenSection
                label={t("library.brandPreview.spacing")}
                tokens={spaceTokens}
                editing={editing}
                valueOf={valueOf}
                onEdit={onEdit}
              />
              <TokenSection
                label={t("library.brandPreview.radius")}
                tokens={radiusTokens}
                editing={editing}
                valueOf={valueOf}
                onEdit={onEdit}
              />
              <TokenSection
                label={t("library.brandPreview.shadows")}
                tokens={shadowTokens}
                editing={editing}
                valueOf={valueOf}
                onEdit={onEdit}
              />
              <TokenSection
                label={t("library.brandPreview.motion")}
                tokens={motionTokens}
                editing={editing}
                valueOf={valueOf}
                onEdit={onEdit}
              />
              <TokenSection
                label={t("library.brandPreview.tokens")}
                tokens={otherTokens}
                editing={editing}
                valueOf={valueOf}
                onEdit={onEdit}
              />

              {/* Voice — brand.md */}
              <div className="flex flex-col gap-3">
                <SectionLabel>
                  {t("library.brandPreview.voiceGuidelines")}
                </SectionLabel>
                {editing ? (
                  <Textarea
                    value={mdText}
                    onChange={(e) => setMdDraft(e.target.value)}
                    placeholder={t("library.brandPreview.voicePlaceholder")}
                    className="min-h-48 font-mono text-sm"
                  />
                ) : brandMd.isPending && mdExists ? (
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-5/6" />
                  </div>
                ) : mdText.trim() ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <MemoizedMarkdown
                      id={`brand-preview-${brandPath}`}
                      text={mdText}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("library.brandPreview.noVoiceYet")}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Mobile: near-fullscreen dialog. */
export function BrandPreviewDialog({
  brandPath,
  onClose,
}: {
  brandPath: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[88vh] w-[94vw] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl!"
        closeButtonClassName="hidden"
      >
        <BrandPreviewContent
          brandPath={brandPath}
          onClose={onClose}
          variant="dialog"
        />
      </DialogContent>
    </Dialog>
  );
}

/** Desktop: right-side panel (consistent with file previews). */
