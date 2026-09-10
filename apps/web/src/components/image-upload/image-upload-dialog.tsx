/**
 * Pick an image, frame it, upload it.
 *
 * Deliberately knows nothing about avatars or about where bytes go: the caller
 * supplies `onUpload`, so the same dialog serves a profile picture, an app
 * icon or a cover image, each writing to whichever storage owns it. Cropping
 * happens in the browser and the result is re-encoded to a bounded square, so
 * a multi-megabyte phone photo arrives as a small file instead of bouncing off
 * the upload limit.
 */

import { useRef, useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Slider } from "@decocms/ui/components/slider.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Trash01, Upload01 } from "@untitledui/icons";
import { toast } from "@decocms/ui/components/sonner.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  clampOffset,
  coverScale,
  outputSize,
  sourceRect,
  type CropGeometry,
  type Offset,
} from "./crop";

/** Side of the crop viewport, in CSS pixels. */
const VIEWPORT = 288;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export interface GalleryItem {
  path: string;
  url: string;
  current: boolean;
}

export interface ImageGallery {
  items: GalleryItem[];
  /** Re-pick something already stored. */
  onSelect: (path: string) => Promise<unknown>;
  /** Omit to hide the per-item delete affordance. */
  onDelete?: (path: string) => Promise<unknown>;
}

export interface ImageUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Circle for avatars, square for everything else. Visual only — the crop
   *  is square either way, which is what a round mask needs. */
  shape?: "circle" | "square";
  /** Longest side of the encoded output. */
  maxOutputSize?: number;
  accept: string[];
  maxBytes: number;
  /** Persist the cropped bytes. Return the URL, or null if it failed. */
  onUpload: (blob: Blob) => Promise<string | null>;
  gallery?: ImageGallery;
}

interface LoadedImage {
  element: HTMLImageElement;
  url: string;
  width: number;
  height: number;
}

/** Decode a file far enough to know its natural size. */
function loadImage(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () =>
      resolve({
        element,
        url,
        width: element.naturalWidth,
        height: element.naturalHeight,
      });
    element.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    element.src = url;
  });
}

/** Re-encode the framed square. WebP everywhere it is supported, PNG if not. */
function encodeCrop(image: LoadedImage, geometry: CropGeometry, max: number) {
  const rect = sourceRect(geometry);
  const size = outputSize(rect, max);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.drawImage(
    image.element,
    rect.sx,
    rect.sy,
    rect.size,
    rect.size,
    0,
    0,
    size,
    size,
  );

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", 0.92);
  });
}

export function ImageUploadDialog({
  open,
  onOpenChange,
  title,
  description,
  shape = "circle",
  maxOutputSize = 512,
  accept,
  maxBytes,
  onUpload,
  gallery,
}: ImageUploadDialogProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);

  const [image, setImage] = useState<LoadedImage | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);

  const rounded = shape === "circle" ? "rounded-full" : "rounded-xl";

  function discardImage() {
    if (image) URL.revokeObjectURL(image.url);
    setImage(null);
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }

  function close() {
    discardImage();
    onOpenChange(false);
  }

  async function pickFile(file: File) {
    if (!accept.includes(file.type)) {
      toast.error(t("imageUpload.unsupportedType"));
      return;
    }
    if (file.size > maxBytes) {
      toast.error(
        t("imageUpload.tooLarge", {
          max: String(Math.round(maxBytes / (1024 * 1024))),
        }),
      );
      return;
    }
    try {
      discardImage();
      setImage(await loadImage(file));
    } catch {
      toast.error(t("imageUpload.decodeFailed"));
    }
  }

  const geometry: CropGeometry | null = image && {
    imageWidth: image.width,
    imageHeight: image.height,
    viewport: VIEWPORT,
    zoom,
    offset,
  };
  const clamped = geometry ? clampOffset(geometry) : { x: 0, y: 0 };
  const scale = geometry ? coverScale(geometry) * zoom : 1;

  async function save() {
    if (!image || !geometry) return;
    setBusy(true);
    try {
      const blob = await encodeCrop(image, geometry, maxOutputSize);
      if (!blob) {
        toast.error(t("imageUpload.encodeFailed"));
        return;
      }
      if (await onUpload(blob)) close();
    } finally {
      setBusy(false);
    }
  }

  async function runGalleryAction(action: Promise<unknown>) {
    setBusy(true);
    try {
      await action;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="sm:max-w-[26rem]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        {image && geometry ? (
          <div className="flex flex-col items-center gap-4">
            <div
              className={cn(
                "relative overflow-hidden bg-muted touch-none cursor-grab active:cursor-grabbing",
                rounded,
              )}
              style={{ width: VIEWPORT, height: VIEWPORT }}
              onPointerDown={(e) => {
                dragOrigin.current = {
                  x: e.clientX - clamped.x,
                  y: e.clientY - clamped.y,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const origin = dragOrigin.current;
                if (!origin) return;
                setOffset({
                  x: e.clientX - origin.x,
                  y: e.clientY - origin.y,
                });
              }}
              onPointerUp={(e) => {
                dragOrigin.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onPointerCancel={() => {
                dragOrigin.current = null;
              }}
              onWheel={(e) => {
                const next = zoom - e.deltaY * 0.002;
                setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
              }}
            >
              <img
                src={image.url}
                alt=""
                draggable={false}
                className="absolute left-1/2 top-1/2 max-w-none select-none"
                style={{
                  width: image.width * scale,
                  height: image.height * scale,
                  transform: `translate(calc(-50% + ${clamped.x}px), calc(-50% + ${clamped.y}px))`,
                }}
              />
            </div>

            <div className="flex w-full items-center gap-3 px-1">
              <span className="text-xs text-muted-foreground shrink-0">
                {t("imageUpload.zoom")}
              </span>
              <Slider
                value={[zoom]}
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                onValueChange={([next]) => setZoom(next ?? MIN_ZOOM)}
                aria-label={t("imageUpload.zoom")}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-10 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Upload01 className="size-5" />
              {t("imageUpload.choose")}
            </button>

            {gallery && gallery.items.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">
                  {t("imageUpload.recent")}
                </span>
                <div className="flex flex-wrap gap-2">
                  {gallery.items.map((item) => (
                    <div key={item.path} className="group relative">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runGalleryAction(
                            gallery.onSelect(item.path),
                          ).then(close)
                        }
                        aria-label={t("imageUpload.usePicture")}
                        className={cn(
                          "size-14 overflow-hidden border transition-opacity hover:opacity-80 disabled:opacity-50",
                          rounded,
                          item.current
                            ? "border-primary ring-2 ring-primary/40"
                            : "border-border",
                        )}
                      >
                        <img
                          src={item.url}
                          alt=""
                          className="size-full object-cover"
                        />
                      </button>
                      {gallery.onDelete && !item.current ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void runGalleryAction(gallery.onDelete!(item.path))
                          }
                          aria-label={t("imageUpload.deletePicture")}
                          className="absolute -right-1 -top-1 hidden rounded-full bg-background p-1 text-muted-foreground shadow-sm hover:text-destructive group-hover:block"
                        >
                          <Trash01 className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={accept.join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void pickFile(file);
          }}
        />

        <DialogFooter>
          {image ? (
            <>
              <Button variant="ghost" onClick={discardImage} disabled={busy}>
                {t("imageUpload.back")}
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? <Spinner size="sm" /> : null}
                {t("imageUpload.save")}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={close}>
              {t("imageUpload.cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
