import { useRef, useState } from "react";
import { Image01, Trash01, Upload01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { ClickToReplaceOverlay } from "./click-to-replace-overlay";
import { extractUrl } from "./extract-url";
import { FieldLabel } from "./field-label";
import type { FieldProps } from "./field-props";
import { basename, extension } from "./media-filename";
import { MediaTransformControls } from "./media-transform-controls";
import { isSafeImageUrl, safeImageSrc } from "./safe-image-url";
import { ACCEPTED_IMAGE_TYPES, useImageUpload } from "./use-image-upload";
import {
  useServeAssetSrc,
  useServeAssetUpload,
} from "./use-serve-asset-upload";

/** How many times a thumbnail served by the site's dev app is retried. */
const SERVED_SRC_RETRIES = 3;

export function ImageField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
  compact,
}: FieldProps) {
  const t = useT();
  const strValue = extractUrl(value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageErrored, setImageErrored] = useState(false);
  // An author types this field, so the value is untrusted until it has been
  // through `safeImageSrc`; an unsafe scheme reduces to "".
  // On a connected `deco serve` (v8), `/assets/*` loads from the site's dev
  // app; everywhere else this is `strValue` unchanged.
  const servedSrc = useServeAssetSrc(sandbox, strValue);
  // A file just uploaded to `deco serve` can 404 for a moment, until the dev
  // app's file watcher sees it: a dev-app thumbnail is retried a few times
  // before it shows as unavailable.
  const [loadRetry, setLoadRetry] = useState(0);
  const src = safeImageSrc(
    loadRetry > 0
      ? `${servedSrc}${servedSrc.includes("?") ? "&" : "?"}retry=${loadRetry}`
      : servedSrc,
  );
  const unsafe = !!strValue && !src;
  const fileName = strValue ? basename(strValue) : "";
  const ext = fileName ? extension(fileName) : "";

  /**
   * Reset the load/error tracking when the underlying URL changes. Used
   * by every code path that swaps the value — input, picker, drop, trash.
   * Without this, a single failed load would conditionally unmount the
   * <img> permanently and the field would be stuck on "Preview
   * unavailable" forever (also why the <img> below has key={strValue}
   * — belt-and-suspenders).
   */
  function setValue(next: string) {
    setImageLoaded(false);
    setImageErrored(false);
    setLoadRetry(0);
    onChange(next);
  }

  /**
   * What the input shows, which is not always what is stored.
   *
   * A keystroke that is refused cannot simply be dropped on a controlled
   * input: `https:` is not yet a safe URL, so rejecting the colon snapped the
   * field back to the previous text and the address could be pasted but never
   * typed. The text is kept as a draft and the value commits at each whole,
   * safe step on the way.
   */
  const [urlDraft, setUrlDraft] = useState(strValue);
  // Re-seed when the value changes elsewhere — picker, drop, trash.
  const [seenUrl, setSeenUrl] = useState(strValue);
  if (seenUrl !== strValue) {
    setSeenUrl(strValue);
    setUrlDraft(strValue);
  }

  /**
   * Keep what the author types, but never persist a scheme that must not
   * reach a `src` — the payload feeds the site, not only this preview. An
   * empty field is allowed through; `missingPostFields` is what flags it.
   */
  function setTypedValue(next: string) {
    setUrlDraft(next);
    const trimmed = next.trim();
    if (trimmed && !isSafeImageUrl(trimmed)) return;
    if (trimmed === strValue) return;
    // Keep the re-seed from reading this write back as an outside change and
    // overwriting a draft that is still mid-address.
    setSeenUrl(trimmed);
    setValue(trimmed);
  }

  /** On the way out, stop showing an address that was never stored. */
  function revertUnsafeDraft() {
    if (urlDraft.trim() && !isSafeImageUrl(urlDraft)) setUrlDraft(strValue);
  }

  const serveUpload = useServeAssetUpload(sandbox);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Choose a file: the system file dialog for `deco serve`, else the picker. */
  const browse = () =>
    serveUpload ? fileInputRef.current?.click() : setPickerOpen(true);

  const { isDragging, isPending, lockedConfigId, dropProps, handleFiles } =
    useImageUpload({
      siteSlug: sandbox?.siteSlug,
      onUploaded: setValue,
      onNeedsPicker: () => setPickerOpen(true),
      serveUpload,
    });

  return (
    // grid-cols-[minmax(0,1fr)] forces every child to be at most 100% of
    // the grid, no matter what intrinsic-content sizing tries to do —
    // the only reliable way to bulletproof a deeply-nested form field
    // against a misbehaving min-w-0 chain. No `overflow-hidden` here: it
    // clips the input/button focus rings and right borders (cutting off the
    // URL input + Browse button); the grid track already caps width.
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      {/* An empty label means the surrounding surface already names the field. */}
      <div className={cn("min-w-0", !label && "hidden")}>
        <FieldLabel
          htmlFor={path}
          label={label}
          description={schema.description}
          labelClassName="text-muted-foreground"
          virtualMcpId={sandbox?.virtualMcpId}
        />
      </div>

      <div
        {...dropProps}
        className={cn(
          "group relative w-full overflow-hidden rounded-[var(--studio-surface-radius,var(--radius-xl))] border card-shadow border-border/60 bg-muted/30 transition",
          isDragging && "border-primary ring-2 ring-primary/30",
          isPending && "pointer-events-none opacity-60",
        )}
      >
        {strValue ? (
          <>
            <button
              type="button"
              onClick={browse}
              aria-label={t("sectionsEditor.imageField.replaceImage")}
              className={cn(
                "relative block w-full cursor-pointer bg-[image:linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%),linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%)] bg-[position:0_0,8px_8px] [background-size:16px_16px]",
                compact ? "h-28" : "h-40",
              )}
            >
              {!imageErrored && !unsafe && (
                <img
                  // Remount whenever the URL changes so onLoad/onError
                  // wire up fresh for the new src — without this the
                  // load/error tracking can stick to the prior value.
                  key={strValue}
                  src={src}
                  alt={label}
                  className={cn(
                    "h-full w-full object-contain transition-opacity",
                    !imageLoaded && "opacity-0",
                  )}
                  onLoad={() => setImageLoaded(true)}
                  onError={() => {
                    if (
                      servedSrc !== strValue &&
                      loadRetry < SERVED_SRC_RETRIES
                    ) {
                      setTimeout(() => setLoadRetry((n) => n + 1), 600);
                    } else {
                      setImageErrored(true);
                    }
                  }}
                />
              )}
              {(imageErrored || unsafe) && (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                  <Image01 size={20} />
                  <p className="text-xs">
                    {t("sectionsEditor.imageField.previewUnavailable")}
                  </p>
                </div>
              )}
              {!imageLoaded && !imageErrored && !unsafe && (
                <div className="absolute inset-0 animate-pulse bg-muted/60" />
              )}
              <ClickToReplaceOverlay />
            </button>
            {!compact && (
              <div className="flex items-center gap-2 border-t border-border/60 bg-background/50 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {fileName}
                </span>
                {ext && (
                  <span className="shrink-0 rounded-[var(--studio-control-radius,var(--radius))] bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                    {ext}
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={browse}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              compact ? "h-28" : "h-40",
            )}
          >
            <Image01 size={20} />
            <span className="text-sm font-medium">
              {isPending
                ? t("sectionsEditor.imageField.uploading")
                : t("sectionsEditor.imageField.dropImageOrClickToBrowse")}
            </span>
            {!compact && (
              <span className="text-xs text-muted-foreground">
                {t("sectionsEditor.imageField.supportedFormatsAndSize")}
              </span>
            )}
          </button>
        )}

        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
            <span className="rounded-md bg-background px-3 py-1.5 text-xs font-medium shadow">
              {t("sectionsEditor.imageField.dropToUpload")}
            </span>
          </div>
        )}
      </div>

      <div className="flex w-full min-w-0 items-center gap-2">
        <Input
          id={path}
          type="url"
          value={urlDraft}
          onChange={(e) => setTypedValue(e.target.value)}
          onBlur={revertUnsafeDraft}
          onKeyDown={(e) => {
            if (e.key === "Escape") setUrlDraft(strValue);
          }}
          placeholder={t("sectionsEditor.imageField.urlPlaceholder")}
          className="h-9 min-w-0 flex-1"
        />
        {!strValue && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={browse}
            className="h-9 shrink-0"
          >
            <Upload01 size={14} />
            {t("sectionsEditor.imageField.browse")}
          </Button>
        )}
        {strValue && (
          <>
            <MediaTransformControls value={strValue} onChange={setValue} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setValue("")}
              className="h-9 shrink-0"
              aria-label={t("sectionsEditor.imageField.removeImage")}
            >
              <Trash01 size={14} />
            </Button>
          </>
        )}
      </div>

      {serveUpload ? (
        <input
          ref={fileInputRef}
          type="file"
          accept={[...ACCEPTED_IMAGE_TYPES].join(",")}
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      ) : (
        <FilePickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          mode="image"
          onSelect={(url) => setValue(url)}
          lockedConfigId={lockedConfigId}
        />
      )}
    </div>
  );
}
