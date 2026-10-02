import { type ReactNode, useState } from "react";
import { Image01, Link01, Monitor01, Phone01 } from "@untitledui/icons";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { useT } from "@/i18n/use-t.ts";
import type { SandboxConfig } from "./field-props";
import {
  getQualityFromUrl,
  QUALITY_OPTIONS,
  setQualityOnUrl,
} from "./media-url-params";
import { ToolbarButton, ToolbarDivider } from "../toolbar-button";
import { safeImageSrc } from "./safe-image-url";
import { useImageUpload } from "./use-image-upload";

/**
 * A desktop image paired with an optional mobile one — the shape the blog app
 * now takes for a post cover (`image` / `mobileImage`) and for a body image
 * block (`url` / `mobileUrl`).
 *
 * The two sources share ONE preview: a desktop/mobile pair in the toolbar
 * swaps which URL is being edited, so the URL field and the quality control
 * always act on the breakpoint you are looking at. Stacking a second preview
 * doubled the height of a field most posts fill once.
 *
 * Everything is on the surface or one labelled click away — no "⋮". A prop an
 * author cannot find is a prop that never gets filled.
 */
export function ResponsiveImageField({
  value,
  mobileValue,
  onChange,
  onMobileChange,
  label,
  alt,
  toolbarExtras,
  sandbox,
}: {
  value: unknown;
  mobileValue: unknown;
  onChange: (next: string | undefined) => void;
  onMobileChange: (next: string | undefined) => void;
  /** Omit where the surrounding surface already names the field. */
  label?: string;
  /** Alt text for the preview itself; the owner decides where it is edited. */
  alt?: string;
  /** Extra toolbar buttons, rendered first — a block's own width/priority. */
  toolbarExtras?: ReactNode;
  sandbox?: SandboxConfig | null;
}) {
  const t = useT();
  const [onMobile, setOnMobile] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  /**
   * The URL whose load failed, rather than a boolean: switching slot or
   * source clears the error on its own, and the <img> below needs no `key`.
   * Remounting it on every src change drops the painted frame, which is what
   * made the preview flicker and shift while a new quality loaded.
   */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const mobileUrl = str(mobileValue);
  const active = onMobile ? mobileUrl : str(value);

  // The author types this field, so the value is untrusted until it has been
  // through `safeImageSrc`; an unsafe scheme reduces to "".
  const src = safeImageSrc(active);
  const errored = !!active && (failedUrl === active || !src);
  const quality = getQualityFromUrl(active);
  const urlLabel = onMobile
    ? t("sectionsEditor.imageField.mobileUrlLabel")
    : t("sectionsEditor.imageField.urlLabel");

  const setActive = (next: string | undefined) =>
    (onMobile ? onMobileChange : onChange)(next || undefined);

  const { isDragging, isPending, lockedConfigId, dropProps } = useImageUpload({
    siteSlug: sandbox?.siteSlug,
    onUploaded: setActive,
    onNeedsPicker: () => setPickerOpen(true),
  });

  return (
    <div className="group/image relative space-y-2">
      {label && <Label className="text-muted-foreground">{label}</Label>}

      {/* Over the image, not above it: a bar placed above is clipped when the
          field is the first thing in its panel. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
        <div className="pointer-events-none relative flex items-center gap-0.5 rounded-md border bg-popover p-0.5 opacity-0 shadow-md transition-opacity group-hover/image:pointer-events-auto group-hover/image:opacity-100 group-focus-within/image:pointer-events-auto group-focus-within/image:opacity-100">
          {toolbarExtras}
          {toolbarExtras && <ToolbarDivider />}

          <ToolbarButton
            active={!onMobile}
            label={t("sectionsEditor.imageField.desktopSlot")}
            onClick={() => setOnMobile(false)}
          >
            <Monitor01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={onMobile}
            label={t("sectionsEditor.imageField.mobileSlot")}
            onClick={() => setOnMobile(true)}
          >
            {/* Tinted when a mobile image exists, so its presence reads
                without opening the slot. */}
            <Phone01 size={14} className={cn(mobileUrl && "text-primary")} />
          </ToolbarButton>

          <ToolbarButton
            active={urlOpen}
            label={urlLabel}
            onClick={() => setUrlOpen((v) => !v)}
          >
            <Link01 size={14} />
          </ToolbarButton>

          {/* Quality is a `?quality=` param on the slot's own URL, so it is
              only offered once that slot has one. */}
          {active && (
            <>
              <ToolbarDivider />
              {QUALITY_OPTIONS.map((option) => (
                <ToolbarButton
                  key={option}
                  active={quality === option}
                  label={option}
                  onClick={() =>
                    setActive(
                      setQualityOnUrl(
                        active,
                        quality === option ? undefined : option,
                      ),
                    )
                  }
                >
                  <span className="px-0.5 text-xs capitalize">{option}</span>
                </ToolbarButton>
              ))}
            </>
          )}

          {urlOpen && (
            <div className="absolute left-0 top-full z-20 mt-1.5 w-96 rounded-[var(--studio-surface-radius,var(--radius-md))] border bg-popover p-1 shadow-md">
              <Input
                // oxlint-disable-next-line no-autofocus -- the panel only opens on an explicit click; focus must land on the input to paste into
                autoFocus
                type="url"
                value={active}
                onChange={(e) => setActive(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") {
                    setUrlOpen(false);
                  }
                }}
                placeholder={t("sectionsEditor.imageField.urlPlaceholder")}
                spellCheck={false}
                aria-label={urlLabel}
                className="h-8 w-full text-xs"
              />
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        {...dropProps}
        onClick={() => setPickerOpen(true)}
        aria-label={t("sectionsEditor.imageField.replaceImage")}
        className={cn(
          "relative block w-full cursor-pointer overflow-hidden rounded-[var(--studio-surface-radius,var(--radius-xl))] transition",
          !active &&
            "border border-dashed border-border/60 bg-muted/30 hover:bg-muted/50",
          isDragging && "ring-2 ring-primary/40",
          isPending && "pointer-events-none opacity-60",
        )}
      >
        {src && !errored ? (
          <img
            src={src}
            alt={alt ?? ""}
            onError={() => setFailedUrl(active)}
            className="block h-auto w-full"
          />
        ) : (
          <span className="flex h-32 w-full flex-col items-center justify-center gap-1.5 text-sm text-muted-foreground">
            <Image01 size={20} />
            {isPending
              ? t("sectionsEditor.imageField.uploading")
              : errored
                ? t("sectionsEditor.imageField.previewUnavailable")
                : onMobile
                  ? t("sectionsEditor.imageField.dropMobileImage")
                  : t("sectionsEditor.imageField.dropImageOrClickToBrowse")}
          </span>
        )}

        {isDragging && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
            <span className="rounded-md bg-background px-3 py-1.5 text-xs font-medium shadow">
              {t("sectionsEditor.imageField.dropToUpload")}
            </span>
          </span>
        )}
      </button>

      <FilePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="image"
        onSelect={setActive}
        lockedConfigId={lockedConfigId}
      />
    </div>
  );
}
